import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  Test,
  TestingModuleBuilder,
} from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import {
  FIXTURE_PRODUCTS,
} from './../src/cart/catalog.client.js';
import { closePool, getPool } from './../src/db/pool.js';
import { RedisService } from './../src/redis/redis.service.js';
import {
  cartOutboxRowsFor,
  countCartOutboxFor,
  deleteCartOutbox,
  type CartOutboxRow,
} from './outbox.helpers.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const TEE = FIXTURE_PRODUCTS[0];
const MUG = FIXTURE_PRODUCTS[1];
const UNAVAILABLE = FIXTURE_PRODUCTS[2];
const RUN_ID = randomUUID().slice(0, 8);

describe('Cart CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let userAToken: string;
  let userBToken: string;
  let guestCartId: string;
  let teeItemId: string;
  let mugItemId: string;

  const userIds = [randomUUID(), randomUUID()];
  const guestSessions = [`guest-${randomUUID()}`, `guest-${randomUUID()}`];
  /** Every cart this suite touches; the outbox assertions count these only. */
  const trackedCartIds: string[] = [];

  /** The old in-process spy, replaced by the rows `cart.outbox` holds. */
  async function eventCount(): Promise<number> {
    return countCartOutboxFor(pool, trackedCartIds);
  }

  async function lastEvent(): Promise<CartOutboxRow> {
    const rows = await cartOutboxRowsFor(pool, trackedCartIds);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('expected at least one cart.outbox row');
    }
    return last;
  }

  function track(cartId: string): string {
    if (!trackedCartIds.includes(cartId)) {
      trackedCartIds.push(cartId);
    }
    return cartId;
  }

  beforeAll(async () => {
    app = await createApp();

    const config = app.get(ConfigService);
    const jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });

    userAToken = await signToken(jwt, userIds[0]);
    userBToken = await signToken(jwt, userIds[1]);
    pool = getPool();
  });

  afterAll(async () => {
    if (pool) {
      await deleteCartOutbox(pool, trackedCartIds);
      await pool.query(
        `DELETE FROM cart.carts
          WHERE user_id = ANY($1::uuid[])
             OR session_id = ANY($2::text[])`,
        [userIds, guestSessions],
      );
    }

    await cleanupRedisKeys();

    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('rejects a request with no user or guest identity', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed bearer token instead of falling back to a session', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', 'Bearer not-a-token')
      .set('x-session-id', guestSessions[0])
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('ignores a body session_id when no header or cookie identity exists', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-idempotency-key', key('body-session'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 1,
        session_id: guestSessions[0],
      })
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates and reuses one active cart for a guest header', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('x-session-id', guestSessions[0])
      .expect(200);

    guestCartId = track(first.body.cart.id);
    expect(first.body.cart).toMatchObject({
      userId: null,
      sessionId: guestSessions[0],
      status: 'active',
    });
    expect(first.body.items).toEqual([]);
    expect(first.body.totals).toEqual({
      subtotal: 0,
      itemCount: 0,
      lineCount: 0,
    });

    const second = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('x-session-id', guestSessions[0])
      .expect(200);

    expect(second.body.cart.id).toBe(guestCartId);
  });

  it('accepts the guest session from the x-session-id cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Cookie', `x-session-id=${guestSessions[1]}`)
      .expect(200);

    track(response.body.cart.id);
    expect(response.body.cart).toMatchObject({
      userId: null,
      sessionId: guestSessions[1],
      status: 'active',
    });
  });

  it('creates a user cart from a verified JWT', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(200);

    track(response.body.cart.id);
    expect(response.body.cart).toMatchObject({
      userId: userIds[0],
      sessionId: null,
      status: 'active',
    });
  });

  it('requires an idempotency key on mutations', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 1,
      })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(await eventCount()).toBe(before);
  });

  it('adds a catalog snapshot and computes totals', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-tee'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 2,
      })
      .expect(201);

    teeItemId = response.body.item.id;
    expect(response.body.item).toMatchObject({
      productId: TEE.productId,
      variantId: TEE.variantId,
      qty: 2,
      unitPrice: TEE.unitPrice,
      productName: TEE.productName,
      productSlug: TEE.productSlug,
      imageUrl: TEE.imageUrl,
      variantLabel: TEE.variantLabel,
    });
    expect(response.body.cartTotals).toEqual({
      subtotal: 159.98,
      itemCount: 2,
      lineCount: 1,
    });

    expect(await eventCount()).toBe(before + 1);
    expect((await lastEvent()).envelope.payload).toMatchObject({
      cartId: guestCartId,
      sessionId: guestSessions[0],
      userId: null,
      totals: { subtotal: 159.98, itemCount: 2, lineCount: 1 },
    });
  });

  it('replays an identical mutation without adding a second line or event', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-tee'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 2,
      })
      .expect(201);

    expect(response.body.item.id).toBe(teeItemId);
    expect(response.body.item.qty).toBe(2);
    expect(await eventCount()).toBe(before);

    const cart = await getCart(guestSessions[0]);
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0].qty).toBe(2);
  });

  it('rejects reuse of an idempotency key with a different body', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-tee'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 3,
      })
      .expect(409);

    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await eventCount()).toBe(before);
  });

  it('increments an existing line when the same product is added with a new key', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-tee-more'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 1,
      })
      .expect(201);

    expect(response.body.item.id).toBe(teeItemId);
    expect(response.body.item.qty).toBe(3);
    expect(response.body.cartTotals).toEqual({
      subtotal: 239.97,
      itemCount: 3,
      lineCount: 1,
    });
    expect(await eventCount()).toBe(before + 1);
  });

  it('adds a second product and reports both lines', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-mug'))
      .send({
        productId: MUG.productId,
        qty: 2,
      })
      .expect(201);

    mugItemId = response.body.item.id;
    expect(response.body.cartTotals).toEqual({
      subtotal: 264.97,
      itemCount: 5,
      lineCount: 2,
    });
    expect(await eventCount()).toBe(before + 1);
  });

  it('updates a quantity and keeps totals consistent', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/cart/items/${teeItemId}`)
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('update-tee'))
      .send({ qty: 1 })
      .expect(200);

    expect(response.body.item).toMatchObject({
      id: teeItemId,
      qty: 1,
    });
    expect(response.body.cartTotals).toEqual({
      subtotal: 104.99,
      itemCount: 3,
      lineCount: 2,
    });
    expect(await eventCount()).toBe(before + 1);
  });

  it('returns 404 for an item owned by another user', async () => {
    const add = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${userBToken}`)
      .set('x-idempotency-key', key('user-b-add'))
      .send({ productId: MUG.productId, qty: 1 })
      .expect(201);

    // User B's cart is mutated by this suite, so its rows count as ours.
    track(await userCartId(userBToken));
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/cart/items/${add.body.item.id}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .set('x-idempotency-key', key('user-a-foreign'))
      .send({ qty: 2 })
      .expect(404);

    expect(response.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    expect(await eventCount()).toBe(before);
  });

  it('returns 404 for an item owned by another guest session', async () => {
    const add = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[1])
      .set('x-idempotency-key', key('guest-b-add'))
      .send({ productId: MUG.productId, qty: 1 })
      .expect(201);

    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/cart/items/${add.body.item.id}`)
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('guest-a-foreign'))
      .send({ qty: 2 })
      .expect(404);

    expect(response.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    expect(await eventCount()).toBe(before);
  });

  it('removes one item, replays the 204, and emits once', async () => {
    const before = await eventCount();
    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${teeItemId}`)
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('remove-tee'))
      .expect(204);

    expect(await eventCount()).toBe(before + 1);

    const replay = await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${teeItemId}`)
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('remove-tee'))
      .expect(204);

    expect(replay.text).toBe('');
    expect(await eventCount()).toBe(before + 1);

    const cart = await getCart(guestSessions[0]);
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0].id).toBe(mugItemId);
    expect(cart.body.totals).toEqual({
      subtotal: 25,
      itemCount: 2,
      lineCount: 1,
    });
  });

  it('batch-removes known ids, ignores missing ids, and returns 404 for a foreign set', async () => {
    const add = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('add-tee-again'))
      .send({
        productId: TEE.productId,
        variantId: TEE.variantId,
        qty: 1,
      })
      .expect(201);

    const before = await eventCount();
    await request(app.getHttpServer())
      .delete('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('batch-remove'))
      .send({ ids: [mugItemId, randomUUID()] })
      .expect(204);

    expect(await eventCount()).toBe(before + 1);

    const cart = await getCart(guestSessions[0]);
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0].id).toBe(add.body.item.id);
    expect(cart.body.totals).toEqual({
      subtotal: 79.99,
      itemCount: 1,
      lineCount: 1,
    });

    const beforeForeign = await eventCount();
    const foreign = await request(app.getHttpServer())
      .delete('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('batch-foreign'))
      .send({ ids: [randomUUID()] })
      .expect(404);

    expect(foreign.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    expect(await eventCount()).toBe(beforeForeign);
  });

  it('clears the cart, replays the 204, and emits once', async () => {
    const before = await eventCount();
    await request(app.getHttpServer())
      .delete('/api/v1/cart')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('clear-cart'))
      .expect(204);

    expect(await eventCount()).toBe(before + 1);

    await request(app.getHttpServer())
      .delete('/api/v1/cart')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('clear-cart'))
      .expect(204);

    expect(await eventCount()).toBe(before + 1);

    const cart = await getCart(guestSessions[0]);
    expect(cart.body.items).toEqual([]);
    expect(cart.body.totals).toEqual({
      subtotal: 0,
      itemCount: 0,
      lineCount: 0,
    });
  });

  it('rejects an unavailable product with 422 and no event', async () => {
    const before = await eventCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', guestSessions[0])
      .set('x-idempotency-key', key('unavailable'))
      .send({ productId: UNAVAILABLE.productId, qty: 1 })
      .expect(422);

    expect(response.body.error.code).toBe('CART_PRODUCT_UNAVAILABLE');
    expect(await eventCount()).toBe(before);
  });

  it('fails closed with 503 when Redis is unavailable', async () => {
    const before = await eventCount();
    const downApp = await createApp(true);

    try {
      const response = await request(downApp.getHttpServer())
        .post('/api/v1/cart/items')
        .set('x-session-id', guestSessions[0])
        .set('x-idempotency-key', key('redis-down'))
        .send({ productId: MUG.productId, qty: 1 })
        .expect(503);

      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(await eventCount()).toBe(before);
    } finally {
      await downApp.close();
    }
  });

  async function getCart(sessionId: string) {
    return request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('x-session-id', sessionId)
      .expect(200);
  }

  async function userCartId(token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return response.body.cart.id;
  }
});

async function createApp(redisDown = false): Promise<INestApplication<App>> {
  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
  });

  if (redisDown) {
    builder = builder.overrideProvider(RedisService).useValue({
      get: async () => {
        throw new Error('Redis is down');
      },
      set: async () => {
        throw new Error('Redis is down');
      },
    });
  }

  const moduleFixture = await builder.compile();
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

function key(label: string): string {
  return `${RUN_ID}-${label}`;
}

async function cleanupRedisKeys(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  try {
    const keys = await redis.keys('idem:*');
    const testKeys = keys.filter((keyName) => keyName.includes(RUN_ID));
    if (testKeys.length > 0) {
      await redis.del(...testKeys);
    }
  } finally {
    await redis.quit();
  }
}
