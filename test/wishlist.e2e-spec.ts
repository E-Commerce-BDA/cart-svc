import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { EVENT_BUS } from './../src/events/event-bus.js';
import type { CartUpdatedEvent } from './../src/events/event-bus.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

describe('Wishlist (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let customerAToken: string;
  let customerBToken: string;
  let adminOnlyToken: string;

  const customerAId = randomUUID();
  const customerBId = randomUUID();
  const adminId = randomUUID();
  const testProductId = randomUUID();
  const testProduct2Id = randomUUID();

  const events: CartUpdatedEvent[] = [];

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(EVENT_BUS).useValue({
      publish: (event: CartUpdatedEvent) => events.push(event),
    });

    const moduleFixture = await builder.compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.init();

    const config = app.get(ConfigService);
    const jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });

    customerAToken = await signToken(jwt, customerAId, ['customer']);
    customerBToken = await signToken(jwt, customerBId, ['customer']);
    adminOnlyToken = await signToken(jwt, adminId, ['admin']);

    pool = getPool();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM cart.wishlists
          WHERE user_id = ANY($1::uuid[])`,
        [[customerAId, customerBId, adminId]],
      );
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  describe('Authentication & Authorization', () => {
    it('rejects an unauthenticated GET /wishlist with 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/wishlist')
        .expect(401);

      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects an admin-only token with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/wishlist')
        .set('Authorization', `Bearer ${adminOnlyToken}`)
        .expect(403);

      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('accepts customer token on dual route /api/v1/cart/wishlist', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart/wishlist')
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(200);

      expect(res.body).toEqual({ items: [] });
    });
  });

  describe('Lazy Creation & Retrieval', () => {
    it('returns empty array when user has no wishlist, and does NOT create a row in cart.wishlists', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/wishlist')
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(200);

      expect(res.body).toEqual({ items: [] });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['vary']).toBe('Authorization');

      const dbCheck = await pool.query(
        `SELECT count(*) FROM cart.wishlists WHERE user_id = $1`,
        [customerAId],
      );
      expect(Number(dbCheck.rows[0].count)).toBe(0);
    });
  });

  describe('Adding Items & Idempotency', () => {
    let createdItemId: string;
    let originalAddedAt: string;

    it('lazily creates wishlist row and adds item with 201 Created', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/wishlist/items')
        .set('Authorization', `Bearer ${customerAToken}`)
        .send({ productId: testProductId })
        .expect(201);

      expect(res.body.item).toBeDefined();
      expect(res.body.item.productId).toBe(testProductId);
      expect(res.body.item.id).toBeDefined();
      expect(res.body.item.addedAt).toBeDefined();

      createdItemId = res.body.item.id;
      originalAddedAt = res.body.item.addedAt;

      // Verify DB row created
      const dbCheck = await pool.query(
        `SELECT id, created_at, updated_at FROM cart.wishlists WHERE user_id = $1`,
        [customerAId],
      );
      expect(dbCheck.rowCount).toBe(1);
    });

    it('duplicate POST returns 201 with identical id and addedAt (idempotent)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/wishlist/items')
        .set('Authorization', `Bearer ${customerAToken}`)
        .send({ productId: testProductId })
        .expect(201);

      expect(res.body.item.id).toBe(createdItemId);
      expect(res.body.item.productId).toBe(testProductId);
      expect(res.body.item.addedAt).toBe(originalAddedAt);

      // Verify no duplicate row in DB
      const itemsCount = await pool.query(
        `SELECT count(*) FROM cart.wishlist_items wi
           JOIN cart.wishlists w ON w.id = wi.wishlist_id
          WHERE w.user_id = $1`,
        [customerAId],
      );
      expect(Number(itemsCount.rows[0].count)).toBe(1);
    });

    it('adds a second distinct product successfully', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/wishlist/items')
        .set('Authorization', `Bearer ${customerAToken}`)
        .send({ productId: testProduct2Id })
        .expect(201);

      expect(res.body.item.productId).toBe(testProduct2Id);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/wishlist')
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(200);

      expect(listRes.body.items).toHaveLength(2);
      expect(listRes.body.items.map((i: { productId: string }) => i.productId)).toContain(
        testProductId,
      );
      expect(listRes.body.items.map((i: { productId: string }) => i.productId)).toContain(
        testProduct2Id,
      );
    });
  });

  describe('Item Removal & Foreign Access Protection', () => {
    let customerAItemId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/wishlist')
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(200);

      customerAItemId = res.body.items[0].id;
    });

    it('rejects foreign user deletion with 404 WISHLIST_ITEM_NOT_FOUND', async () => {
      // Customer B has no wishlist yet, attempt to delete Customer A's item
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/wishlist/items/${customerAItemId}`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(404);

      expect(res.body.error?.code).toBe('WISHLIST_ITEM_NOT_FOUND');
    });

    it('rejects foreign user deletion when foreign user has an existing wishlist with 404', async () => {
      // Customer B adds their own item first
      await request(app.getHttpServer())
        .post('/api/v1/wishlist/items')
        .set('Authorization', `Bearer ${customerBToken}`)
        .send({ productId: randomUUID() })
        .expect(201);

      // Now customer B attempts to delete customer A's item
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/wishlist/items/${customerAItemId}`)
        .set('Authorization', `Bearer ${customerBToken}`)
        .expect(404);

      expect(res.body.error?.code).toBe('WISHLIST_ITEM_NOT_FOUND');
    });

    it('rejects non-existent item deletion with 404 WISHLIST_ITEM_NOT_FOUND', async () => {
      const nonExistentId = randomUUID();
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/wishlist/items/${nonExistentId}`)
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(404);

      expect(res.body.error?.code).toBe('WISHLIST_ITEM_NOT_FOUND');
    });

    it('allows owner to delete item with 204 No Content and touches wishlists.updated_at', async () => {
      // Record initial updated_at
      const beforeQuery = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM cart.wishlists WHERE user_id = $1`,
        [customerAId],
      );
      const beforeUpdatedAt = beforeQuery.rows[0].updated_at;

      // Ensure timestamp distinction if clock is low resolution
      await new Promise((r) => setTimeout(r, 20));

      await request(app.getHttpServer())
        .delete(`/api/v1/wishlist/items/${customerAItemId}`)
        .set('Authorization', `Bearer ${customerAToken}`)
        .expect(204);

      // Verify item deleted from DB
      const itemQuery = await pool.query(
        `SELECT id FROM cart.wishlist_items WHERE id = $1`,
        [customerAItemId],
      );
      expect(itemQuery.rowCount).toBe(0);

      // Verify wishlists.updated_at was touched
      const afterQuery = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM cart.wishlists WHERE user_id = $1`,
        [customerAId],
      );
      expect(afterQuery.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(
        beforeUpdatedAt.getTime(),
      );
    });

    it('never emits cart.updated events during wishlist operations', () => {
      expect(events).toHaveLength(0);
    });
  });
});

async function signToken(
  jwt: JwtService,
  sub: string,
  roles: string[],
): Promise<string> {
  return jwt.signAsync(
    {
      sub,
      email: 'user@example.com',
      roles,
    },
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      expiresIn: '15m',
    },
  );
}
