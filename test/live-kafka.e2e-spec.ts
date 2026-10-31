import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Kafka, type Consumer } from 'kafkajs';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  parseEventEnvelope,
  readEventEnvelope,
  type CanonicalEventEnvelope,
} from '@ecom/contracts';
import {
  KafkaEventPublisher,
  OutboxRelay,
  RecordingLogger,
  type EventTopic,
  type OutboxStorePort,
  type OutboxWriteInput,
  type Queryable,
} from '@ecom/messaging';
import {
  OUTBOX_PUBLISHER,
  OUTBOX_RELAY,
  OUTBOX_STORE,
} from '@ecom/messaging/nest';
import { AppModule } from './../src/app.module.js';
import { FIXTURE_PRODUCTS } from './../src/cart/catalog.client.js';
import { closePool, getPool } from './../src/db/pool.js';
import {
  cartOutboxRows,
  cartUpdatedPayload,
  deleteCartOutbox,
} from './outbox.helpers.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const TEE = FIXTURE_PRODUCTS[0];
const RUN_ID = randomUUID().slice(0, 8);
const RUN_LIVE = process.env.RUN_KAFKA_E2E === '1';

function brokers(): string[] {
  return (process.env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

interface CapturedMessage {
  key: string | null;
  value: string;
}

describe.runIf(RUN_LIVE)('cart.updated over a real broker (live)', () => {
  let app: INestApplication<App>;
  let publisher: KafkaEventPublisher;
  let relay: OutboxRelay;
  let store: OutboxStorePort;
  let consumer: Consumer;

  const sessionId = `guest-live-${RUN_ID}-${randomUUID()}`;
  const captured: CapturedMessage[] = [];
  let cartId: string;

  beforeAll(async () => {
    await assertBrokerReady('cart.updated');

    publisher = new KafkaEventPublisher({
      brokers,
      clientId: `cart-svc-live-${RUN_ID}`,
    });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    relay = moduleFixture.get<OutboxRelay>(OUTBOX_RELAY);
    store = moduleFixture.get<OutboxStorePort>(OUTBOX_STORE);

    // Subscribe before producing: `fromBeginning: false` only sees new records.
    const kafka = new Kafka({
      clientId: `cart-svc-live-consumer-${RUN_ID}`,
      brokers: brokers(),
      connectionTimeout: 5000,
    });
    consumer = kafka.consumer({ groupId: `cart-svc-live-${RUN_ID}` });
    await consumer.connect();
    await consumer.subscribe({ topic: 'cart.updated', fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        captured.push({
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? '',
        });
      },
    });

    // The group join is asynchronous; give it a moment before producing.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 60_000);

  afterAll(async () => {
    if (consumer) {
      await consumer.disconnect();
    }

    if (cartId) {
      await deleteCartOutbox(getPool(), [cartId]);
      await getPool().query(`DELETE FROM cart.carts WHERE session_id = $1`, [
        sessionId,
      ]);
    }

    if (relay) {
      relay.stop();
    }

    if (publisher) {
      await publisher.close();
    }

    if (app) {
      await app.close();
    }
    await closePool();
  }, 60_000);

  it('publishes one cart.updated keyed by cartId, readable and validated', async () => {
    const opened = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('x-session-id', sessionId)
      .expect(200);
    cartId = opened.body.cart.id;

    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('x-session-id', sessionId)
      .set('x-idempotency-key', `${RUN_ID}-live-add`)
      .send({
        productId: TEE.productId,
        ...(TEE.variantId ? { variantId: TEE.variantId } : {}),
        qty: 1,
      })
      .expect(201);

    const [row] = await cartOutboxRows(getPool(), cartId);
    expect(row!.status).toBe('pending');

    await drainUntilPublished(cartId);

    const message = await waitFor(
      () => captured.find((entry) => entry.key === cartId),
      15_000,
      `no cart.updated record keyed ${cartId} on the topic`,
    );

    expect(message.key).toBe(cartId);

    const envelope: CanonicalEventEnvelope = readEventEnvelope(
      JSON.parse(message.value),
    );
    expect(envelope.type).toBe('cart.updated');
    expect(envelope.version).toBe(1);
    expect(envelope.idempotencyKey).toBe(envelope.id);
    expect(envelope.id).toBe(row!.event_id);

    const payload = parseEventEnvelope('cart.updated', envelope);
    expect(payload.cartId).toBe(cartId);
    expect(payload.items).toHaveLength(1);
    expect(payload.totals).toEqual({ subtotal: TEE.unitPrice, itemCount: 1, lineCount: 1 });
    expect(payload).toEqual(cartUpdatedPayload(row!));

    const [published] = await cartOutboxRows(getPool(), cartId);
    expect(published!.status).toBe('published');
    expect(published!.published_at).toBeInstanceOf(Date);
  }, 60_000);

  /**
   * Publish the pending rows of this cart only.
   *
   * The store is scoped to one aggregate so a live run never claims — and sends
   * to the real broker — a row that another spec file left pending in the shared
   * database.
   */
  async function drainUntilPublished(target: string): Promise<void> {
    const scoped = new OutboxRelay({
      store: onlyCart(store, target),
      publisher,
      logger: new RecordingLogger(),
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rows = await cartOutboxRows(getPool(), target);
      if (rows.every((row) => row.status === 'published')) {
        return;
      }
      await scoped.drainOnce();
    }

    throw new Error(`relay did not publish cart ${target}`);
  }
});

/** Narrow the store to one aggregate id, for a shared test database. */
function onlyCart(
  store: OutboxStorePort,
  cartId: string,
  limit = 200,
): OutboxStorePort {
  return {
    write: <T extends EventTopic>(
      client: Queryable,
      input: OutboxWriteInput<T>,
    ) => store.write(client, input),
    claimBatch: async (_limit, leaseSeconds) => {
      const rows = await store.claimBatch(limit, leaseSeconds);
      return rows.filter((row) => row.aggregate_id === cartId);
    },
    markPublished: (id) => store.markPublished(id),
    markFailed: (id, error, maxAttempts, backoffSeconds) =>
      store.markFailed(id, error, maxAttempts, backoffSeconds),
    tryAcquireRelayLock: () => store.tryAcquireRelayLock(),
  };
}

/** Fail with an actionable message rather than a kafkajs timeout. */
async function assertBrokerReady(topic: string): Promise<void> {
  const admin = new Kafka({
    clientId: `cart-svc-live-admin-${RUN_ID}`,
    brokers: brokers(),
    connectionTimeout: 5000,
  }).admin();
  const endpoint = brokers().join(', ');

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `ecom-kafka is not reachable at ${endpoint} (${
        (error as Error).message
      }). Start it with \`docker compose up -d ecom-kafka\`.`,
    );
  }

  try {
    const topics = await admin.listTopics();
    if (!topics.includes(topic)) {
      throw new Error(
        `topic '${topic}' is missing at ${endpoint}. Provision it with ` +
          '`ecom-infra/scripts/provision-topics.mjs`.',
      );
    }
  } finally {
    await admin.disconnect();
  }
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  failure: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = probe();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(failure);
}
