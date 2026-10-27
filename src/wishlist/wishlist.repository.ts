import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import type { WishlistItem } from './wishlist.types.js';

interface WishlistItemRow {
  id: string;
  productId: string;
  addedAt: Date;
}

@Injectable()
export class WishlistRepository {
  async findItemsByUserId(userId: string): Promise<WishlistItem[]> {
    const { rows } = await getPool().query<WishlistItemRow>(
      `SELECT wi.id, wi.product_id AS "productId", wi.added_at AS "addedAt"
         FROM cart.wishlists w
         JOIN cart.wishlist_items wi ON wi.wishlist_id = w.id
        WHERE w.user_id = $1
        ORDER BY wi.added_at DESC`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      addedAt:
        row.addedAt instanceof Date
          ? row.addedAt.toISOString()
          : new Date(row.addedAt).toISOString(),
    }));
  }

  async addItem(userId: string, productId: string): Promise<WishlistItem> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const wishlistRes = await client.query<{ id: string }>(
        `INSERT INTO cart.wishlists (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [userId],
      );
      const wishlistId = wishlistRes.rows[0].id;

      const itemRes = await client.query<WishlistItemRow>(
        `INSERT INTO cart.wishlist_items (wishlist_id, product_id)
         VALUES ($1, $2)
         ON CONFLICT (wishlist_id, product_id) DO UPDATE
           SET added_at = cart.wishlist_items.added_at
         RETURNING id, product_id AS "productId", added_at AS "addedAt"`,
        [wishlistId, productId],
      );

      await client.query(
        `UPDATE cart.wishlists SET updated_at = now() WHERE id = $1`,
        [wishlistId],
      );

      await client.query('COMMIT');

      const row = itemRes.rows[0];
      return {
        id: row.id,
        productId: row.productId,
        addedAt:
          row.addedAt instanceof Date
            ? row.addedAt.toISOString()
            : new Date(row.addedAt).toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeItem(userId: string, itemId: string): Promise<boolean> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const wishlistRes = await client.query<{ id: string }>(
        `SELECT id FROM cart.wishlists WHERE user_id = $1`,
        [userId],
      );

      if (wishlistRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      const wishlistId = wishlistRes.rows[0].id;

      const deleteRes = await client.query(
        `DELETE FROM cart.wishlist_items
          WHERE id = $1 AND wishlist_id = $2`,
        [itemId, wishlistId],
      );

      if (deleteRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `UPDATE cart.wishlists SET updated_at = now() WHERE id = $1`,
        [wishlistId],
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
