import type { CartUpdatedPayload, EventEnvelope } from '@ecom/contracts';
import type { Pool } from 'pg';

/**
 * A `cart.outbox` row as the e2e suites read it.
 *
 * Every helper is scoped by `aggregate_id` (the cart id): vitest runs spec files
 * in parallel against one database, so a global `count(*)` is not stable.
 */
export interface CartOutboxRow {
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  envelope: EventEnvelope;
  status: string;
  attempts: number;
  last_error: string | null;
  locked_until: Date | null;
  created_at: Date;
  published_at: Date | null;
}

const OUTBOX_COLUMNS = `id, event_id, aggregate_type, aggregate_id, event_type,
       envelope, status, attempts, last_error, locked_until, created_at,
       published_at`;

/** All rows written for one cart, in publish order. */
export async function cartOutboxRows(
  pool: Pool,
  cartId: string,
): Promise<CartOutboxRow[]> {
  return cartOutboxRowsFor(pool, [cartId]);
}

/** How many `cart.updated` rows one cart owns. */
export async function countCartOutbox(
  pool: Pool,
  cartId: string,
): Promise<number> {
  return countCartOutboxFor(pool, [cartId]);
}

/**
 * Rows for a set of carts, oldest first. A suite that mutates several carts
 * counts them together, which is the closest equivalent of the in-process spy
 * it used to assert on.
 */
export async function cartOutboxRowsFor(
  pool: Pool,
  cartIds: string[],
): Promise<CartOutboxRow[]> {
  if (cartIds.length === 0) {
    return [];
  }

  const { rows } = await pool.query<CartOutboxRow>(
    `SELECT ${OUTBOX_COLUMNS}
       FROM cart.outbox
      WHERE aggregate_id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [cartIds],
  );

  return rows;
}

export async function countCartOutboxFor(
  pool: Pool,
  cartIds: string[],
): Promise<number> {
  if (cartIds.length === 0) {
    return 0;
  }

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM cart.outbox WHERE aggregate_id = ANY($1::uuid[])`,
    [cartIds],
  );

  return Number(rows[0]!.count);
}

/** Teardown: the carts go, so their events go too. */
export async function deleteCartOutbox(
  pool: Pool,
  cartIds: string[],
): Promise<void> {
  if (cartIds.length === 0) {
    return;
  }

  await pool.query(
    `DELETE FROM cart.outbox WHERE aggregate_id = ANY($1::uuid[])`,
    [cartIds],
  );
}

/**
 * The payload of a `cart.updated` row, typed as the contract's payload.
 *
 * A store row keeps `payload` as `Record<string, unknown>` (the envelope schema
 * cannot know the topic), so the assertions read it through this accessor
 * rather than casting at every call site.
 */
export function cartUpdatedPayload(row: CartOutboxRow): CartUpdatedPayload {
  return row.envelope.payload as unknown as CartUpdatedPayload;
}
