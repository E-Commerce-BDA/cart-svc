import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
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
import type { CatalogProductSnapshot } from './../src/cart/catalog.client.js';
import { closePool, getPool } from './../src/db/pool.js';
import { EVENT_BUS } from './../src/events/event-bus.js';
import type { CartUpdatedEvent } from './../src/events/event-bus.js';
import { SettingsService } from './../src/settings/settings.service.js';
import type { GuestMergeStrategy } from './../src/settings/settings.registry.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const TEE = FIXTURE_PRODUCTS[0];
const MUG = FIXTURE_PRODUCTS[1];
const RUN_ID = randomUUID().slice(0, 8);

interface Shopper {
  userId: string;
  sessionId: string;
  token: string;
}

describe('Cart merge (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let pool: Pool;
  let currentPolicy: GuestMergeStrategy = 'merge';

  const events: CartUpdatedEvent[] = [];
  const userIds: string[] = [];
  const guestSessions: string[] = [];

  beforeAll(async () => {
    app = await createApp(events, () => currentPolicy);

    const config = app.get(ConfigService);
    jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });
    pool = getPool();
  });

  beforeEach(() => {
    currentPolicy = 'merge';
    events.length = 0;
  });

  afterAll(async () => {
    if (pool) {
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

  it('requires an idempotency key on merge', async () => {
    const shopper = await newShopper();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('x-session-id', shopper.sessionId)
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(events).toHaveLength(0);
  });

  it('requires x-session-id when the user is verified', async () => {
    const shopper = await newShopper();
    await getCart(shopper, 'user');

    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('x-idempotency-key', key('missing-session'))
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(events).toHaveLength(0);
  });

  it('rejects a guest-only merge', async () => {
    const shopper = await newShopper();
    await getCart(shopper, 'guest');

    const response = await request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('x-session-id', shopper.sessionId)
      .set('x-idempotency-key', key('guest-only'))
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect(events).toHaveLength(0);
  });

  it('merge sums matching lines, appends guest-only lines, and retries as a no-op', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    const guestCart = await getCart(shopper, 'guest');

    await addItem(shopper, TEE, 1, 'merge-user-tee', 'user');
    await addItem(shopper, TEE, 2, 'merge-guest-tee', 'guest');
    await addItem(shopper, MUG, 1, 'merge-guest-mug', 'guest');

    currentPolicy = 'merge';
    const before = events.length;
    const response = await merge(shopper, 'merge-both').expect(200);

    expect(Object.keys(response.body)).toEqual(['cart']);
    expect(response.body.cart).toMatchObject({
      id: userCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
    });
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1]).toMatchObject({
      cartId: userCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
      totals: { subtotal: 252.47, itemCount: 4, lineCount: 2 },
    });
    expect(events[events.length - 1].items).toHaveLength(2);

    const cart = await getCart(shopper, 'user');
    expect(cart.body.items).toHaveLength(2);
    expect(findLine(cart.body, TEE.productId, TEE.variantId)?.qty).toBe(3);
    expect(findLine(cart.body, MUG.productId, MUG.variantId)?.qty).toBe(1);
    expect(cart.body.totals).toEqual({
      subtotal: 252.47,
      itemCount: 4,
      lineCount: 2,
    });
    expect(await cartStatus(guestCart.body.cart.id)).toBe('converted');
    expect(await cartItemCount(guestCart.body.cart.id)).toBe(2);

    const replay = await merge(shopper, 'merge-both').expect(200);
    expect(replay.body.cart.id).toBe(userCart.body.cart.id);
    expect(events).toHaveLength(before + 1);

    const naturalRetry = await merge(shopper, 'merge-both-again').expect(200);
    expect(naturalRetry.body.cart.id).toBe(userCart.body.cart.id);
    expect(events).toHaveLength(before + 1);

    const afterRetry = await getCart(shopper, 'user');
    expect(findLine(afterRetry.body, TEE.productId, TEE.variantId)?.qty).toBe(
      3,
    );
    expect(findLine(afterRetry.body, MUG.productId, MUG.variantId)?.qty).toBe(
      1,
    );
  });

  it('merge sums matching null-variant lines without duplicates', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    await getCart(shopper, 'guest');

    await addItem(shopper, MUG, 1, 'null-user-mug', 'user');
    await addItem(shopper, MUG, 2, 'null-guest-mug', 'guest');

    currentPolicy = 'merge';
    const before = events.length;
    const response = await merge(shopper, 'merge-null-variant').expect(200);

    expect(response.body.cart.id).toBe(userCart.body.cart.id);
    const cart = await getCart(shopper, 'user');
    expect(cart.body.items).toHaveLength(1);
    expect(findLine(cart.body, MUG.productId, MUG.variantId)?.qty).toBe(3);
    expect(cart.body.totals).toEqual({
      subtotal: 37.5,
      itemCount: 3,
      lineCount: 1,
    });
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1].items).toHaveLength(1);
  });

  it('guest_wins adopts the guest cart and converts the old user cart', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    const guestCart = await getCart(shopper, 'guest');

    await addItem(shopper, TEE, 1, 'guest-wins-user-tee', 'user');
    await addItem(shopper, MUG, 2, 'guest-wins-guest-mug', 'guest');

    currentPolicy = 'guest_wins';
    const before = events.length;
    const response = await merge(shopper, 'guest-wins').expect(200);

    expect(response.body.cart).toMatchObject({
      id: guestCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
    });
    expect(await cartStatus(userCart.body.cart.id)).toBe('converted');
    expect(await cartStatus(guestCart.body.cart.id)).toBe('active');
    expect(await cartItemCount(userCart.body.cart.id)).toBe(1);

    const cart = await getCart(shopper, 'user');
    expect(cart.body.cart.id).toBe(guestCart.body.cart.id);
    expect(cart.body.items).toHaveLength(1);
    expect(findLine(cart.body, MUG.productId, MUG.variantId)?.qty).toBe(2);
    expect(cart.body.totals).toEqual({
      subtotal: 25,
      itemCount: 2,
      lineCount: 1,
    });
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1]).toMatchObject({
      cartId: guestCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      totals: { subtotal: 25, itemCount: 2, lineCount: 1 },
    });
  });

  it('user_wins keeps the user cart and converts the guest cart', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    const guestCart = await getCart(shopper, 'guest');

    await addItem(shopper, TEE, 1, 'user-wins-user-tee', 'user');
    await addItem(shopper, MUG, 2, 'user-wins-guest-mug', 'guest');

    currentPolicy = 'user_wins';
    const before = events.length;
    const response = await merge(shopper, 'user-wins').expect(200);

    expect(response.body.cart.id).toBe(userCart.body.cart.id);
    expect(await cartStatus(guestCart.body.cart.id)).toBe('converted');
    expect(await cartItemCount(guestCart.body.cart.id)).toBe(1);

    const cart = await getCart(shopper, 'user');
    expect(cart.body.items).toHaveLength(1);
    expect(findLine(cart.body, TEE.productId, TEE.variantId)?.qty).toBe(1);
    expect(findLine(cart.body, MUG.productId, MUG.variantId)).toBeUndefined();
    expect(cart.body.totals).toEqual({
      subtotal: 79.99,
      itemCount: 1,
      lineCount: 1,
    });
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1]).toMatchObject({
      cartId: userCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
    });
  });

  it('user_wins adopts guest items when the user cart is empty', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    const guestCart = await getCart(shopper, 'guest');

    await addItem(shopper, MUG, 2, 'user-wins-empty-guest-mug', 'guest');

    currentPolicy = 'user_wins';
    const before = events.length;
    const response = await merge(shopper, 'user-wins-empty').expect(200);

    expect(response.body.cart).toMatchObject({
      id: guestCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
    });
    expect(await cartStatus(userCart.body.cart.id)).toBe('converted');
    expect(await cartStatus(guestCart.body.cart.id)).toBe('active');
    expect(await cartItemCount(userCart.body.cart.id)).toBe(0);

    const cart = await getCart(shopper, 'user');
    expect(cart.body.cart.id).toBe(guestCart.body.cart.id);
    expect(findLine(cart.body, MUG.productId, MUG.variantId)?.qty).toBe(2);
    expect(events).toHaveLength(before + 1);
  });

  it('merge adopts the guest cart when no user cart exists', async () => {
    const shopper = await newShopper();
    const guestCart = await getCart(shopper, 'guest');
    await addItem(shopper, TEE, 1, 'only-guest-tee', 'guest');

    currentPolicy = 'merge';
    const before = events.length;
    const response = await merge(shopper, 'merge-only-guest').expect(200);

    expect(response.body.cart).toMatchObject({
      id: guestCart.body.cart.id,
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
    });
    expect(await cartStatus(guestCart.body.cart.id)).toBe('active');

    const cart = await getCart(shopper, 'user');
    expect(cart.body.cart.id).toBe(guestCart.body.cart.id);
    expect(findLine(cart.body, TEE.productId, TEE.variantId)?.qty).toBe(1);
    expect(events).toHaveLength(before + 1);
  });

  it('only-user merge is a no-op with no event', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    await addItem(shopper, TEE, 1, 'only-user-tee', 'user');

    currentPolicy = 'merge';
    const before = events.length;
    const response = await merge(shopper, 'merge-only-user').expect(200);

    expect(response.body.cart.id).toBe(userCart.body.cart.id);
    expect(await cartStatus(userCart.body.cart.id)).toBe('active');
    expect(events).toHaveLength(before);
  });

  it('both-empty merge keeps the user cart and converts the guest cart', async () => {
    const shopper = await newShopper();
    const userCart = await getCart(shopper, 'user');
    const guestCart = await getCart(shopper, 'guest');

    currentPolicy = 'merge';
    const before = events.length;
    const response = await merge(shopper, 'merge-empty').expect(200);

    expect(response.body.cart.id).toBe(userCart.body.cart.id);
    expect(await cartStatus(guestCart.body.cart.id)).toBe('converted');
    expect(events).toHaveLength(before + 1);
    expect(events[events.length - 1]).toMatchObject({
      cartId: userCart.body.cart.id,
      totals: { subtotal: 0, itemCount: 0, lineCount: 0 },
    });
  });

  it('creates a user cart without an event when neither cart exists', async () => {
    const shopper = await newShopper();

    currentPolicy = 'merge';
    const response = await merge(shopper, 'merge-none').expect(200);

    expect(response.body.cart).toMatchObject({
      userId: shopper.userId,
      sessionId: null,
      status: 'active',
    });
    expect(events).toHaveLength(0);
  });

  async function newShopper(): Promise<Shopper> {
    const userId = randomUUID();
    const sessionId = `guest-${RUN_ID}-${randomUUID()}`;
    userIds.push(userId);
    guestSessions.push(sessionId);

    return {
      userId,
      sessionId,
      token: await signToken(jwt, userId),
    };
  }

  async function getCart(
    shopper: Shopper,
    as: 'user' | 'guest' = 'user',
  ) {
    const req = request(app.getHttpServer()).get('/api/v1/cart');

    if (as === 'user') {
      req.set('Authorization', `Bearer ${shopper.token}`);
    } else {
      req.set('x-session-id', shopper.sessionId);
    }

    return req.expect(200);
  }

  async function addItem(
    shopper: Shopper,
    product: CatalogProductSnapshot,
    qty: number,
    label: string,
    as: 'user' | 'guest' = 'guest',
  ) {
    const req = request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-idempotency-key', key(label))
      .send({
        productId: product.productId,
        variantId: product.variantId,
        qty,
      });

    if (as === 'user') {
      req.set('Authorization', `Bearer ${shopper.token}`);
    } else {
      req.set('x-session-id', shopper.sessionId);
    }

    return req.expect(201);
  }

  function merge(shopper: Shopper, label: string) {
    return request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('x-session-id', shopper.sessionId)
      .set('x-idempotency-key', key(label));
  }

  async function cartStatus(cartId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM cart.carts WHERE id = $1`,
      [cartId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Cart ${cartId} not found`);
    }
    return row.status;
  }

  async function cartItemCount(cartId: string): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM cart.cart_items
        WHERE cart_id = $1`,
      [cartId],
    );
    const row = rows[0];
    return row ? row.count : 0;
  }
});

function findLine(
  body: {
    items: Array<{
      productId: string;
      variantId: string | null;
      qty: number;
    }>;
  },
  productId: string,
  variantId: string | null,
) {
  return body.items.find(
    (item) =>
      item.productId === productId && item.variantId === variantId,
  );
}

async function createApp(
  events: CartUpdatedEvent[],
  policy: () => GuestMergeStrategy,
): Promise<INestApplication<App>> {
  const builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EVENT_BUS)
    .useValue({
      publish: (event: CartUpdatedEvent) => events.push(event),
    })
    .overrideProvider(SettingsService)
    .useValue({
      getGuestMergeStrategy: async () => policy(),
    });

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
