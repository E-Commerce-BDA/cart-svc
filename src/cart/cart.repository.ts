import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import type { CartIdentity } from '../auth/guards/cart-identity.guard.js';
import { getPool } from '../db/pool.js';
import type { CatalogProductSnapshot } from './catalog.client.js';

export interface CartRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  status: string;
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
}

export interface DeleteMutation {
  deletedCount: number;
  cart: CartRow | null;
}

const CART_COLUMNS = `id, user_id, session_id, status, last_activity_at, created_at, updated_at`;
const ITEM_COLUMNS = `id, cart_id, product_id, variant_id, qty, unit_price, product_name, product_slug, image_url, variant_label, added_at`;

@Injectable()
export class CartRepository {
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

  async findItems(cartId: string): Promise<CartItemRow[]> {
    const { rows } = await getPool().query<CartItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM cart.cart_items
        WHERE cart_id = $1
        ORDER BY added_at ASC, id ASC`,
      [cartId],
    );

    return rows;
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
      return { item: rows[0], cart };
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
      return { item: rows[0], cart };
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

      return this.touchCart(client, cartId);
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

      return { deletedCount: rowCount ?? 0, cart };
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

  private async touchCart(
    client: PoolClient,
    cartId: string,
  ): Promise<CartRow> {
    const { rows } = await client.query<CartRow>(
      `UPDATE cart.carts
          SET last_activity_at = now()
        WHERE id = $1
        RETURNING ${CART_COLUMNS}`,
      [cartId],
    );

    const cart = rows[0];
    if (!cart) {
      throw new Error(`Active cart ${cartId} disappeared during mutation`);
    }

    return cart;
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
