import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import type { CartUpdatedPayload } from '@ecom/contracts';
import type { Queryable } from '@ecom/messaging';
import type { CartIdentity } from '../auth/guards/cart-identity.guard.js';
import { getPool } from '../db/pool.js';
import type { GuestMergeStrategy } from '../settings/settings.registry.js';
import { CartOutbox } from '../outbox/cart-outbox.js';
import type { CatalogProductSnapshot } from './catalog.client.js';

/** The one payload field the database constrains; kept in the contract's terms. */
export type CartStatus = CartUpdatedPayload['status'];

export interface CartRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  status: CartStatus;
  last_activity_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CartItemRow {
  id: string;
  cart_id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  unit_price: string;
  product_name: string;
  product_slug: string | null;
  image_url: string | null;
  variant_label: string | null;
  added_at: Date;
}

export interface ItemMutation {
  item: CartItemRow;
  cart: CartRow;
  /**
   * The items the outbox row was built from, read inside the mutation's
   * transaction. The service reports totals from these instead of re-reading
   * the cart after commit, where a concurrent mutation could have landed.
   */
  items: CartItemRow[];
}

export interface DeleteMutation {
  deletedCount: number;
  cart: CartRow | null;
}

export interface MergeResult {
  cart: CartRow;
  changed: boolean;
}

const CART_COLUMNS = `id, user_id, session_id, status, last_activity_at, created_at, updated_at`;
const ITEM_COLUMNS = `id, cart_id, product_id, variant_id, qty, unit_price, product_name, product_slug, image_url, variant_label, added_at`;

@Injectable()
export class CartRepository {
  constructor(private readonly outbox: CartOutbox) {}

  async findActiveCart(identity: CartIdentity): Promise<CartRow | null> {
    const column = identity.type === 'user' ? 'user_id' : 'session_id';
    const value =
      identity.type === 'user' ? identity.userId : identity.sessionId;

    const { rows } = await getPool().query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart.carts
        WHERE ${column} = $1
          AND status = 'active'
        LIMIT 1`,
      [value],
    );

    return rows[0] ?? null;
  }

  async ensureActiveCart(identity: CartIdentity): Promise<CartRow> {
    const existing = await this.findActiveCart(identity);
    if (existing) {
      return existing;
    }

    try {
      return await this.insertActiveCart(identity);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.findActiveCart(identity);
      if (winner) {
        return winner;
      }
      throw error;
    }
  }

  /**
   * `client` is optional so the read-only paths keep using the pool, while a
   * mutation passes its transaction client to read the same snapshot the
   * outbox payload will describe.
   *
   * The structural `Queryable` port deliberately erases row types, so the
   * result is asserted here rather than widening the port for `pg`.
   */
  async findItems(
    cartId: string,
    client: Queryable = getPool(),
  ): Promise<CartItemRow[]> {
    const { rows } = await client.query(
      `SELECT ${ITEM_COLUMNS}
         FROM cart.cart_items
        WHERE cart_id = $1
        ORDER BY added_at ASC, id ASC`,
      [cartId],
    );

    return rows as CartItemRow[];
  }

  async addItem(
    cartId: string,
    snapshot: CatalogProductSnapshot,
    qty: number,
  ): Promise<ItemMutation> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<CartItemRow>(
        `INSERT INTO cart.cart_items
           (cart_id, product_id, variant_id, qty, unit_price, product_name,
            product_slug, image_url, variant_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (cart_id, product_id, variant_id)
         DO UPDATE SET qty = cart.cart_items.qty + EXCLUDED.qty
         RETURNING ${ITEM_COLUMNS}`,
        [
          cartId,
          snapshot.productId,
          snapshot.variantId,
          qty,
          snapshot.unitPrice.toFixed(2),
          snapshot.productName,
          snapshot.productSlug,
          snapshot.imageUrl,
          snapshot.variantLabel,
        ],
      );

      const cart = await this.touchCart(client, cartId);
      const items = await this.record(client, cart);
      return { item: rows[0], cart, items };
    });
  }

  async updateItemQty(
    cartId: string,
    itemId: string,
    qty: number,
  ): Promise<ItemMutation | null> {
    return this.withTransaction(async (client) => {
      const { rows, rowCount } = await client.query<CartItemRow>(
        `UPDATE cart.cart_items
            SET qty = $1
          WHERE id = $2
            AND cart_id = $3
          RETURNING ${ITEM_COLUMNS}`,
        [qty, itemId, cartId],
      );

      if (rowCount !== 1) {
        return null;
      }

      const cart = await this.touchCart(client, cartId);
      const items = await this.record(client, cart);
      return { item: rows[0], cart, items };
    });
  }

  async deleteItem(
    cartId: string,
    itemId: string,
  ): Promise<CartRow | null> {
    return this.withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM cart.cart_items
          WHERE id = $1
            AND cart_id = $2`,
        [itemId, cartId],
      );

      if (rowCount !== 1) {
        return null;
      }

      const cart = await this.touchCart(client, cartId);
      await this.record(client, cart);
      return cart;
    });
  }

  async deleteItems(cartId: string, ids: string[]): Promise<DeleteMutation> {
    return this.withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM cart.cart_items
          WHERE cart_id = $1
            AND id = ANY($2::uuid[])`,
        [cartId, ids],
      );
      const deletedCount = rowCount ?? 0;

      if (deletedCount === 0) {
        return { deletedCount, cart: null };
      }

      const cart = await this.touchCart(client, cartId);
      await this.record(client, cart);
      return { deletedCount, cart };
    });
  }

  async clearItems(cartId: string): Promise<DeleteMutation> {
    return this.withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM cart.cart_items
          WHERE cart_id = $1`,
        [cartId],
      );
      const cart = await this.touchCart(client, cartId);
      // A clear of an already-empty cart is still a state change, so it records.
      await this.record(client, cart);

      return { deletedCount: rowCount ?? 0, cart };
    });
  }

  /**
   * Converts the user's active cart in place. The partial unique index
   * `one_active_cart_per_user` guarantees at most one row, but the items must be
   * read against the same snapshot as the status change, so this is a
   * transaction: `UPDATE ... RETURNING` then read items then record.
   */
  async convertActiveCart(userId: string): Promise<CartRow | null> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<CartRow>(
        `UPDATE cart.carts
            SET status = 'converted',
                last_activity_at = now()
          WHERE user_id = $1
            AND status = 'active'
          RETURNING ${CART_COLUMNS}`,
        [userId],
      );

      const cart = rows[0];
      if (!cart) {
        return null;
      }

      await this.record(client, cart);
      return cart;
    });
  }

  async mergeActiveCarts(
    userId: string,
    sessionId: string,
    policy: GuestMergeStrategy,
  ): Promise<MergeResult> {
    try {
      return await this.runMerge(userId, sessionId, policy);
    } catch (error) {
      // A concurrent user-cart creation can win the partial unique index
      // between our lock query and adoption. Retry once so the merge sees the
      // committed winner instead of returning a 500.
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return this.runMerge(userId, sessionId, policy);
    }
  }

  private async runMerge(
    userId: string,
    sessionId: string,
    policy: GuestMergeStrategy,
  ): Promise<MergeResult> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<CartRow>(
        `SELECT ${CART_COLUMNS}
           FROM cart.carts
          WHERE status = 'active'
            AND (user_id = $1 OR session_id = $2)
          ORDER BY id
          FOR UPDATE`,
        [userId, sessionId],
      );

      const userCart = rows.find((cart) => cart.user_id === userId) ?? null;
      const guestCart =
        rows.find(
          (cart) =>
            cart.session_id === sessionId && cart.id !== userCart?.id,
        ) ?? null;

      if (!guestCart) {
        if (userCart) {
          return { cart: userCart, changed: false };
        }

        const created = await this.insertUserCart(client, userId);
        return { cart: created, changed: false };
      }

      const counts = await this.countItems(client, [
        userCart?.id ?? null,
        guestCart.id,
      ]);
      const userHasItems = userCart
        ? (counts.get(userCart.id) ?? 0) > 0
        : false;
      const guestHasItems = (counts.get(guestCart.id) ?? 0) > 0;
      const adoptGuest = shouldAdoptGuest(
        policy,
        userCart !== null,
        userHasItems,
        guestHasItems,
      );

      if (adoptGuest) {
        if (userCart) {
          await this.convertCart(client, userCart.id);
        }

        const adopted = await this.reassignGuestCart(
          client,
          guestCart.id,
          userId,
        );
        await this.record(client, adopted);
        return { cart: adopted, changed: true };
      }

      const target =
        userCart ?? (await this.insertUserCart(client, userId));

      if (policy === 'merge' && userHasItems && guestHasItems) {
        await this.mergeGuestItems(client, target.id, guestCart.id);
      }

      await this.convertCart(client, guestCart.id);
      const touched = await this.touchCart(client, target.id);
      await this.record(client, touched);
      return { cart: touched, changed: true };
    });
  }

  private async insertActiveCart(identity: CartIdentity): Promise<CartRow> {
    const userId = identity.type === 'user' ? identity.userId : null;
    const sessionId =
      identity.type === 'session' ? identity.sessionId : null;

    const { rows } = await getPool().query<CartRow>(
      `INSERT INTO cart.carts (user_id, session_id)
       VALUES ($1, $2)
       RETURNING ${CART_COLUMNS}`,
      [userId, sessionId],
    );

    return rows[0];
  }

  private async insertUserCart(
    client: PoolClient,
    userId: string,
  ): Promise<CartRow> {
    const { rows } = await client.query<CartRow>(
      `INSERT INTO cart.carts (user_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING
       RETURNING ${CART_COLUMNS}`,
      [userId],
    );

    if (rows[0]) {
      return rows[0];
    }

    const existing = await this.findActiveUserCart(client, userId);
    if (!existing) {
      throw new Error(`Could not create an active cart for user ${userId}`);
    }

    return existing;
  }

  private async findActiveUserCart(
    client: PoolClient,
    userId: string,
  ): Promise<CartRow | null> {
    const { rows } = await client.query<CartRow>(
      `SELECT ${CART_COLUMNS}
         FROM cart.carts
        WHERE user_id = $1
          AND status = 'active'
        LIMIT 1`,
      [userId],
    );

    return rows[0] ?? null;
  }

  private async countItems(
    client: PoolClient,
    cartIds: Array<string | null>,
  ): Promise<Map<string, number>> {
    const ids = cartIds.filter((id): id is string => id !== null);
    if (ids.length === 0) {
      return new Map();
    }

    const { rows } = await client.query<{
      cart_id: string;
      item_count: number;
    }>(
      `SELECT cart_id, count(*)::int AS item_count
         FROM cart.cart_items
        WHERE cart_id = ANY($1::uuid[])
        GROUP BY cart_id`,
      [ids],
    );

    return new Map(rows.map((row) => [row.cart_id, row.item_count]));
  }

  private async convertCart(
    client: PoolClient,
    cartId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE cart.carts
          SET status = 'converted'
        WHERE id = $1`,
      [cartId],
    );
  }

  private async reassignGuestCart(
    client: PoolClient,
    cartId: string,
    userId: string,
  ): Promise<CartRow> {
    const { rows } = await client.query<CartRow>(
      `UPDATE cart.carts
          SET user_id = $1,
              session_id = NULL,
              last_activity_at = now()
        WHERE id = $2
        RETURNING ${CART_COLUMNS}`,
      [userId, cartId],
    );

    const cart = rows[0];
    if (!cart) {
      throw new Error(`Guest cart ${cartId} disappeared during merge`);
    }

    return cart;
  }

  private async mergeGuestItems(
    client: PoolClient,
    targetCartId: string,
    guestCartId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO cart.cart_items
         (cart_id, product_id, variant_id, qty, unit_price, product_name,
          product_slug, image_url, variant_label, added_at)
       SELECT $1, product_id, variant_id, qty, unit_price, product_name,
              product_slug, image_url, variant_label, added_at
         FROM cart.cart_items
        WHERE cart_id = $2
       ON CONFLICT (cart_id, product_id, variant_id)
       DO UPDATE SET qty = cart.cart_items.qty + EXCLUDED.qty`,
      [targetCartId, guestCartId],
    );
  }

  private async touchCart(
    client: PoolClient,
    cartId: string,
  ): Promise<CartRow> {
    const { rows } = await client.query<CartRow>(
      `UPDATE cart.carts
          SET last_activity_at = now()
        WHERE id = $1
          AND status = 'active'
        RETURNING ${CART_COLUMNS}`,
      [cartId],
    );

    const cart = rows[0];
    if (!cart) {
      throw new Error(`Active cart ${cartId} disappeared during mutation`);
    }

    return cart;
  }

  /**
   * Reads the post-mutation items and writes the `cart.updated` row, both
   * inside the caller's transaction. Every mutating method funnels through
   * here, so "one committed mutation, one outbox row" holds by construction.
   */
  private async record(
    client: PoolClient,
    cart: CartRow,
  ): Promise<CartItemRow[]> {
    const items = await this.findItems(cart.id, client);
    await this.outbox.record(client, cart, items);
    return items;
  }

  private async withTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function shouldAdoptGuest(
  policy: GuestMergeStrategy,
  hasUserCart: boolean,
  userHasItems: boolean,
  guestHasItems: boolean,
): boolean {
  if (!guestHasItems) {
    return false;
  }

  if (!hasUserCart || policy === 'guest_wins') {
    return true;
  }

  return !userHasItems;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
