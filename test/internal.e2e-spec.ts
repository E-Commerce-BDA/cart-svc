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
import { DEFAULT_INTERNAL_SERVICE_KEY } from './../src/auth/guards/service-key.guard.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import {
  cartOutboxRows,
  cartUpdatedPayload,
  countCartOutbox,
  countCartOutboxFor,
  deleteCartOutbox,
} from './outbox.helpers.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const FRESH_USER = randomUUID();
const SHOPPER = randomUUID();

describe('Internal cart conversion (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let shopperToken: string;
  let cartId: string;

  /** Carts this suite mutates; the outbox assertions count these only. */
  const trackedCartIds: string[] = [];

  async function eventCount(): Promise<number> {
    return countCartOutboxFor(pool, trackedCartIds);
  }

  beforeAll(async () => {
    app = await createApp();

    const config = app.get(ConfigService);
    const jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });
    shopperToken = await signToken(jwt, SHOPPER);
    pool = getPool();

    cartId = await seedCart(pool);
    trackedCartIds.push(cartId);
  });

  afterAll(async () => {
    if (pool) {
      await deleteCartOutbox(pool, trackedCartIds);
      await pool.query(
        `DELETE FROM cart.carts WHERE user_id = ANY($1::uuid[])`,
        [[FRESH_USER, SHOPPER]],
      );
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('does not serve the removed DELETE route', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/api/v1/cart/internal/carts/${SHOPPER}`)
      .set('x-service-key', DEFAULT_INTERNAL_SERVICE_KEY)
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a call without a service key', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/cart/internal/carts/${FRESH_USER}/convert`)
      .expect(401);

    expect(response.body.error.code).toBe('SERVICE_KEY_INVALID');
  });

  it('rejects a wrong service key', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/cart/internal/carts/${FRESH_USER}/convert`)
      .set('x-service-key', 'not-the-key')
      .expect(401);

    expect(response.body.error.code).toBe('SERVICE_KEY_INVALID');
  });

  it('rejects a non-uuid user id', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/internal/carts/not-a-uuid/convert')
      .set('x-service-key', DEFAULT_INTERNAL_SERVICE_KEY)
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('answers 204 when the user has no cart', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/cart/internal/carts/${FRESH_USER}/convert`)
      .set('x-service-key', DEFAULT_INTERNAL_SERVICE_KEY)
      .expect(204);

    expect(response.body).toEqual({});
    expect(await eventCount()).toBe(before);
  });

  it('converts the active cart and keeps its items', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/cart/internal/carts/${SHOPPER}/convert`)
      .set('x-service-key', DEFAULT_INTERNAL_SERVICE_KEY)
      .expect(200);

    expect(response.body).toMatchObject({
      cartId,
      convertedAt: expect.any(String),
    });

    const { rows } = await pool.query<{ status: string; lines: number }>(
      `SELECT c.status, count(i.id)::int AS lines
         FROM cart.carts c
         LEFT JOIN cart.cart_items i ON i.cart_id = c.id
        WHERE c.id = $1
        GROUP BY c.status`,
      [cartId],
    );

    expect(rows[0]).toEqual({ status: 'converted', lines: 1 });

    const outbox = await cartOutboxRows(pool, cartId);
    expect(outbox).toHaveLength(1);
    expect(cartUpdatedPayload(outbox[0]!)).toMatchObject({
      cartId,
      userId: SHOPPER,
      status: 'converted',
      totals: { itemCount: 2, lineCount: 1 },
    });
  });

  it('replays as 204 without publishing again', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/cart/internal/carts/${SHOPPER}/convert`)
      .set('x-service-key', DEFAULT_INTERNAL_SERVICE_KEY)
      .expect(204);

    expect(await countCartOutbox(pool, cartId)).toBe(1);
  });

  it('hands the next cart read a fresh active cart', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('authorization', `Bearer ${shopperToken}`)
      .expect(200);

    expect(response.body.cart.id).not.toBe(cartId);
    expect(response.body.cart.status).toBe('active');
    expect(response.body.items).toEqual([]);
    trackedCartIds.push(response.body.cart.id);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM cart.carts WHERE id = $1`,
      [cartId],
    );

    expect(rows[0].status).toBe('converted');
  });

  async function seedCart(database: Pool): Promise<string> {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO cart.carts (user_id) VALUES ($1) RETURNING id`,
      [SHOPPER],
    );
    const id = rows[0].id;

    await database.query(
      `INSERT INTO cart.cart_items
         (cart_id, product_id, qty, unit_price, product_name, added_at)
       VALUES ($1, $2, 2, 79.99, 'Fixture Tee', now() - interval '2 hours')`,
      [id, randomUUID()],
    );

    return id;
  }
});

async function createApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
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
  return app;
}

async function signToken(jwt: JwtService, sub: string): Promise<string> {
  return jwt.signAsync(
    {
      sub,
      email: 'shopper@example.com',
      roles: ['customer'],
    },
    {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: JWT_ALGORITHM,
      expiresIn: '15m',
    },
  );
}
