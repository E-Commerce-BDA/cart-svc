import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { eventEnvelopeSchema, parseEventEnvelope, type EventTopic } from '@ecom/contracts';
import {
  OutboxRelay,
  RecordingLogger,
  RecordingPublisher,
  type OutboxStorePort,
  type OutboxWriteInput,
  type Queryable,
} from '@ecom/messaging';
import {
  OUTBOX_PUBLISHER,
  OUTBOX_RELAY,
  OUTBOX_STORE,
} from '@ecom/messaging/nest';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import {
  FIXTURE_PRODUCTS,
  type CatalogProductSnapshot,
} from './../src/cart/catalog.client.js';
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

const TEE = FIXTURE_PRODUCTS[0];
const MUG = FIXTURE_PRODUCTS[1];
const RUN_ID = randomUUID().slice(0, 8);

/** Pretend the retry backoff elapsed, so the next drain can claim the row. */
async function expireLease(rowId: string): Promise<void> {
  await getPool().query(
    `UPDATE cart.outbox SET locked_until = now() - interval '1 second' WHERE id = $1`,
    [rowId],
  );
}

/**
 * The relay claims whichever rows are pending, and spec files run in parallel
 * against one database. Cases that count attempts therefore narrow the store to
 * this suite's carts, so a cart mutated elsewhere cannot consume an attempt.
 * `leaseSeconds: 0` keeps the foreign rows this filter drops claimable.
 */
function onlyCarts(
  store: OutboxStorePort,
  cartIds: string[],
  limit = 200,
): OutboxStorePort {
  return {
    write: <T extends EventTopic>(
      client: Queryable,
      input: OutboxWriteInput<T>,
    ) => store.write(client, input),
    claimBatch: async (_limit, leaseSeconds) => {
      const rows = await store.claimBatch(limit, leaseSeconds);
      return rows.filter((row) => cartIds.includes(row.aggregate_id));
    },
    markPublished: (id) => store.markPublished(id),
    markFailed: (id, error, maxAttempts, backoffSeconds) =>
      store.markFailed(id, error, maxAttempts, backoffSeconds),
    tryAcquireRelayLock: () => store.tryAcquireRelayLock(),
  };
}

describe('Cart outbox (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let jwt: JwtService;
  let store: OutboxStorePort;
  let moduleRelay: OutboxRelay;
  let publisher: RecordingPublisher;

  const userIds: string[] = [];
  const guestSessions: string[] = [];
  /** Every cart this suite touches; teardown and assertions scope to these. */
  const trackedCartIds: string[] = [];

  function guestSession(): string {
    const sessionId = `guest-${RUN_ID}-${randomUUID()}`;
    guestSessions.push(sessionId);
    return sessionId;
  }

  function track(cartId: string): string {
    if (!trackedCartIds.includes(cartId)) {
      trackedCartIds.push(cartId);
    }
    return cartId;
  }

  /**
   * Drain the real module relay until the rows for one cart are published.
   * The queue is shared with the other suites (which never start a relay), so a
   * single drain may claim their older rows first.
   */
  async function drainUntilPublished(
    cartId: string,
    expected: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rows = await cartOutboxRows(pool, cartId);
      if (rows.filter((row) => row.status === 'published').length >= expected) {
        return;
      }
      await moduleRelay.drainOnce();
    }

    throw new Error(
      `relay did not publish ${expected} row(s) for cart ${cartId}`,
    );
  }

  beforeAll(async () => {
    publisher = new RecordingPublisher();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();

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
    jwt = new JwtService({
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });
    pool = getPool();
    store = moduleFixture.get<OutboxStorePort>(OUTBOX_STORE);
    moduleRelay = moduleFixture.get<OutboxRelay>(OUTBOX_RELAY);
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

    if (app) {
      await app.close();
    }
    await closePool();
  });

  beforeEach(() => {
    publisher.reset();
  });

  async function getCart(
    identity: { sessionId: string } | { token: string },
  ): Promise<string> {
    const req = request(app.getHttpServer()).get('/api/v1/cart');

    if ('token' in identity) {
      req.set('Authorization', `Bearer ${identity.token}`);
    } else {
      req.set('x-session-id', identity.sessionId);
    }

    const response = await req.expect(200);
    return track(response.body.cart.id);
  }

  function addItem(
    sessionId: string,
    product: CatalogProductSnapshot,
    qty: number,
    label: string,
  ) {
    const body: Record<string, unknown> = {
      productId: product.productId,
      qty,
    };
    if (product.variantId) {
      body.variantId = product.variantId;
    }

    return request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key(label))
      .send(body);
  }

  it('writes exactly one valid cart.updated row when an item is added', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });

    const added = await addItem(sessionId, TEE, 2, 'add').expect(201);

    const rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row).toMatchObject({
      aggregate_type: 'cart',
      aggregate_id: cartId,
      event_type: 'cart.updated',
      status: 'pending',
      attempts: 0,
      last_error: null,
      locked_until: null,
      published_at: null,
    });

    expect(eventEnvelopeSchema.safeParse(row!.envelope).success).toBe(true);
    expect(row!.envelope).toMatchObject({
      id: row!.event_id,
      type: 'cart.updated',
      topic: 'cart.updated',
      eventType: 'cart.updated',
      version: 1,
      producer: 'cart-svc',
      idempotencyKey: row!.event_id,
    });

    const payload = parseEventEnvelope('cart.updated', row!.envelope);
    expect(payload).toMatchObject({
      cartId,
      userId: null,
      sessionId,
      status: 'active',
      updatedAt: row!.envelope.timestamp,
    });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.productId).toBe(TEE.productId);
    expect(payload.items[0]!.qty).toBe(2);
    expect(payload.totals).toEqual(added.body.cartTotals);
  });

  it('writes one row per committed mutation with the totals it reported', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });

    const added = await addItem(sessionId, TEE, 2, 'steps-add').expect(201);
    const teeItemId = added.body.item.id as string;
    expect(await countCartOutbox(pool, cartId)).toBe(1);

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/cart/items/${teeItemId}`)
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key('steps-update'))
      .send({ qty: 3 })
      .expect(200);

    let rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(2);
    expect(cartUpdatedPayload(rows.at(-1)!).totals).toEqual(
      updated.body.cartTotals,
    );

    const withMug = await addItem(sessionId, MUG, 1, 'steps-add-mug').expect(
      201,
    );
    const mugItemId = withMug.body.item.id as string;

    rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(3);
    expect(cartUpdatedPayload(rows.at(-1)!).totals).toEqual(
      withMug.body.cartTotals,
    );

    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${mugItemId}`)
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key('steps-remove-one'))
      .expect(204);

    rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(4);
    expect(cartUpdatedPayload(rows.at(-1)!).items).toHaveLength(1);

    const withMugAgain = await addItem(
      sessionId,
      MUG,
      2,
      'steps-add-mug-again',
    ).expect(201);

    await request(app.getHttpServer())
      .delete('/api/v1/cart/items')
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key('steps-remove-many'))
      .send({ ids: [teeItemId] })
      .expect(204);

    rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(6);
    expect(cartUpdatedPayload(rows.at(-1)!).items).toHaveLength(1);
    expect(cartUpdatedPayload(rows.at(-1)!).totals).toEqual({
      subtotal: Number((MUG.unitPrice * 2).toFixed(2)),
      itemCount: 2,
      lineCount: 1,
    });
    expect(withMugAgain.body.item.id).toBeDefined();

    await request(app.getHttpServer())
      .delete('/api/v1/cart')
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key('steps-clear'))
      .expect(204);

    rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(7);
    expect(cartUpdatedPayload(rows.at(-1)!)).toMatchObject({
      items: [],
      totals: { subtotal: 0, itemCount: 0, lineCount: 0 },
    });
  });

  it('writes nothing for a rejected mutation', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });
    await addItem(sessionId, TEE, 1, 'noop-add').expect(201);

    const before = await countCartOutbox(pool, cartId);

    const response = await request(app.getHttpServer())
      .patch(`/api/v1/cart/items/${randomUUID()}`)
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key('noop-foreign'))
      .send({ qty: 2 })
      .expect(404);

    expect(response.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    expect(await countCartOutbox(pool, cartId)).toBe(before);
  });

  it('writes exactly one row for a merge and none when it is replayed', async () => {
    const userId = randomUUID();
    userIds.push(userId);
    const sessionId = guestSession();
    const token = await signToken(jwt, userId);

    const userCartId = await getCart({ token });
    const guestCartId = await getCart({ sessionId });

    await addItem(sessionId, TEE, 1, 'merge-guest').expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', key('merge-user'))
      .send({ productId: MUG.productId, qty: 1 })
      .expect(201);

    const cartIds = [userCartId, guestCartId];
    const before = await countCartOutboxFor(pool, cartIds);

    const merged = await merge(token, sessionId, 'merge-once').expect(200);
    expect(cartIds).toContain(merged.body.cart.id);
    expect(await countCartOutboxFor(pool, cartIds)).toBe(before + 1);

    await merge(token, sessionId, 'merge-once').expect(200);
    expect(await countCartOutboxFor(pool, cartIds)).toBe(before + 1);

    await merge(token, sessionId, 'merge-twice').expect(200);
    expect(await countCartOutboxFor(pool, cartIds)).toBe(before + 1);
  });

  it('publishes keyed by cartId, in order, and marks the rows published', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });

    await addItem(sessionId, TEE, 1, 'publish-1').expect(201);
    await addItem(sessionId, MUG, 2, 'publish-2').expect(201);

    await drainUntilPublished(cartId, 2);

    const rows = await cartOutboxRows(pool, cartId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('published');
      expect(row.published_at).toBeInstanceOf(Date);
      expect(row.locked_until).toBeNull();
    }

    const published = publisher.published.filter(
      (entry) => entry.key === cartId,
    );
    expect(published).toHaveLength(2);
    // Sequential publish in claim order is what keeps per-cart order honest.
    expect(published[0]!.envelope.id).toBe(rows[0]!.event_id);
    expect(published[1]!.envelope.id).toBe(rows[1]!.event_id);
    expect(published[0]!.topic).toBe('cart.updated');
    expect(published[0]!.envelope).toEqual(rows[0]!.envelope);
  });

  it('records a failed attempt and republishes once the backoff elapses', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });
    await addItem(sessionId, TEE, 1, 'retry-add').expect(201);

    const [row] = await cartOutboxRows(pool, cartId);
    const relay = new OutboxRelay({
      store: onlyCarts(store, [cartId]),
      publisher,
      logger: new RecordingLogger(),
      leaseSeconds: 0,
      maxAttempts: 5,
    });

    publisher.failNext = 1;
    const failed = await relay.drainOnce();
    expect(failed).toMatchObject({ published: 0, failed: 1, skipped: false });

    const [afterFailure] = await cartOutboxRows(pool, cartId);
    expect(afterFailure!.status).toBe('pending');
    expect(afterFailure!.attempts).toBe(1);
    expect(afterFailure!.last_error).toContain('unavailable');
    expect(afterFailure!.locked_until).toBeInstanceOf(Date);
    expect(afterFailure!.published_at).toBeNull();

    await expireLease(row!.id);
    const retried = await relay.drainOnce();
    expect(retried).toMatchObject({ published: 1, failed: 0, skipped: false });

    const [published] = await cartOutboxRows(pool, cartId);
    expect(published!.status).toBe('published');
    expect(published!.attempts).toBe(1);
    expect(published!.last_error).toBeNull();
    expect(
      publisher.published.filter((entry) => entry.key === cartId),
    ).toHaveLength(1);
  });

  it('parks the row as failed after five attempts and never retries it', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });
    await addItem(sessionId, TEE, 1, 'park-add').expect(201);

    const [row] = await cartOutboxRows(pool, cartId);
    const relay = new OutboxRelay({
      store: onlyCarts(store, [cartId]),
      publisher,
      logger: new RecordingLogger(),
      leaseSeconds: 0,
      maxAttempts: 5,
    });

    publisher.failNext = 5;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) {
        // The previous attempt set a backoff on the lease.
        await expireLease(row!.id);
      }
      const result = await relay.drainOnce();
      // A drain that claimed nothing would leave the row short of five attempts.
      expect(result.failed).toBe(1);
    }

    const [parked] = await cartOutboxRows(pool, cartId);
    expect(parked!.status).toBe('failed');
    expect(parked!.attempts).toBe(5);
    expect(parked!.locked_until).toBeNull();
    expect(parked!.last_error).toBeTruthy();

    const sixth = await relay.drainOnce();
    expect(sixth.published).toBe(0);

    const [stillParked] = await cartOutboxRows(pool, cartId);
    expect(stillParked!.attempts).toBe(5);
    expect(stillParked!.status).toBe('failed');
    expect(
      publisher.published.filter((entry) => entry.key === cartId),
    ).toHaveLength(0);
  });

  it('publishes nothing while another worker holds the relay lock', async () => {
    const sessionId = guestSession();
    const cartId = await getCart({ sessionId });
    await addItem(sessionId, TEE, 1, 'lock-add').expect(201);

    const holder = await pool.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('cart.outbox', 0)) AS locked",
      );
      expect(rows[0]!.locked).toBe(true);

      const result = await moduleRelay.drainOnce();

      expect(result).toEqual({ published: 0, failed: 0, skipped: true });

      const [untouched] = await cartOutboxRows(pool, cartId);
      expect(untouched!.status).toBe('pending');
      expect(untouched!.locked_until).toBeNull();
      expect(untouched!.attempts).toBe(0);
      expect(
        publisher.published.filter((entry) => entry.key === cartId),
      ).toHaveLength(0);
    } finally {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtextextended('cart.outbox', 0))",
      );
      holder.release();
    }
  });

  function merge(token: string, sessionId: string, label: string) {
    return request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${token}`)
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', key(label));
  }
});

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
