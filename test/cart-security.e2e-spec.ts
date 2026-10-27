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

describe('Cart Security & Audit (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let adminToken: string;
  let customerToken: string;

  const adminId = randomUUID();
  const customerId = randomUUID();
  const victimId = randomUUID();
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

    adminToken = await signToken(jwt, adminId, ['admin']);
    customerToken = await signToken(jwt, customerId, ['customer']);
    pool = getPool();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM cart.carts
          WHERE user_id = ANY($1::uuid[])`,
        [[adminId, customerId, victimId]],
      );
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  describe('Identity & Header Spoofing Defenses', () => {
    it('refuses to trust client-supplied x-user-id header without valid JWT', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('x-user-id', victimId)
        .expect(401);

      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    });

    it('uses verified JWT subject even if x-user-id or spoofed headers are present', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-user-id', victimId)
        .expect(200);

      expect(res.body.cart.userId).toBe(customerId);
      expect(res.body.cart.userId).not.toBe(victimId);
    });
  });

  describe('Prototype Pollution Defense', () => {
    it('rejects __proto__ in settings values payload', async () => {
      const currentSettings = await request(app.getHttpServer())
        .get('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          version: currentSettings.body.version,
          values: JSON.parse('{"__proto__": {"polluted": true}}'),
        })
        .expect(400);

      expect(res.body.error?.code).toBe('UNKNOWN_SETTING');
    });

    it('rejects constructor in settings reset payload', async () => {
      const currentSettings = await request(app.getHttpServer())
        .get('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          version: currentSettings.body.version,
          reset: ['constructor'],
        })
        .expect(400);

      expect(res.body.error?.code).toBe('UNKNOWN_SETTING');
    });
  });

  describe('Settings Audit Route (ca-006)', () => {
    it('rejects unauthenticated GET /cart/settings/audit with 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart/settings/audit')
        .expect(401);

      expect(res.body.error?.code).toBe('UNAUTHENTICATED');
    });

    it('rejects customer token on GET /cart/settings/audit with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart/settings/audit')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);

      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('allows admin to retrieve audit log entries with 200 OK', async () => {
      // First update a setting to ensure at least one audit entry exists
      const current = await request(app.getHttpServer())
        .get('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const newStrategy =
        current.body.values.guestMergeStrategy === 'merge'
          ? 'user_wins'
          : 'merge';

      await request(app.getHttpServer())
        .patch('/api/v1/cart/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          version: current.body.version,
          values: { guestMergeStrategy: newStrategy },
        })
        .expect(200);

      const auditRes = await request(app.getHttpServer())
        .get('/api/v1/cart/settings/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(auditRes.body.entries).toBeDefined();
      expect(Array.isArray(auditRes.body.entries)).toBe(true);
      expect(auditRes.body.entries.length).toBeGreaterThan(0);

      const latest = auditRes.body.entries[0];
      expect(latest).toMatchObject({
        scope: 'cart.behavior',
        changedBy: adminId,
      });
      expect(latest.newValues).toBeDefined();
      expect(latest.changedAt).toBeDefined();
    });
  });

  describe('Inactive Cart Protection', () => {
    it('does not allow updating items in an inactive/converted cart', async () => {
      // Create an active cart for customer
      const getRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      const cartId = getRes.body.cart.id;

      // Manually mark cart converted in DB (e.g. simulated post-merge state)
      await pool.query(
        `UPDATE cart.carts SET status = 'converted' WHERE id = $1`,
        [cartId],
      );

      // Attempting to update item qty via customer should find or create a new active cart, NOT mutate converted cart
      const updateRes = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${randomUUID()}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ qty: 2 })
        .expect(404);

      expect(updateRes.body.error?.code).toBe('CART_NOT_FOUND');
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
      email: `${roles[0]}@example.com`,
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
