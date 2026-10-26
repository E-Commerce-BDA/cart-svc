import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { closePool, getPool } from '../src/db/pool.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

describe('Cart Schema (e2e)', () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getPool().connect();
    await client.query('BEGIN');
  });

  beforeEach(async () => {
    await client.query('SAVEPOINT test_sp');
  });

  afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT test_sp');
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await closePool();
  });

  it('1. 4 base tables exist in cart schema', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name 
       FROM information_schema.tables 
       WHERE table_schema = 'cart' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    );

    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'cart_items',
      'carts',
      'wishlist_items',
      'wishlists',
    ]);
  });

  it('2. all required indexes exist by name', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname 
       FROM pg_indexes 
       WHERE schemaname = 'cart';`,
    );

    const indexNames = rows.map((r) => r.indexname);
    const expectedIndexes = [
      'one_active_cart_per_user',
      'idx_carts_session_id',
      'idx_carts_abandoned',
      'cart_items_cart_product_unique',
      'idx_cart_items_product_id',
      'idx_wishlist_items_wishlist_id',
      'wishlist_items_unique',
    ];

    for (const expected of expectedIndexes) {
      expect(indexNames).toContain(expected);
    }
  });

  it('3. enforces carts_owner_check (user_id OR session_id must be non-null)', async () => {
    await expect(
      client.query(`
        INSERT INTO cart.carts (user_id, session_id, status)
        VALUES (NULL, NULL, 'active')
      `),
    ).rejects.toThrow(/violates check constraint "carts_owner_check"/);
  });

  it('4. enforces carts_status_check enum values', async () => {
    await expect(
      client.query(`
        INSERT INTO cart.carts (session_id, status)
        VALUES ('sess_123', 'invalid_status')
      `),
    ).rejects.toThrow(/violates check constraint "carts_status_check"/);
  });

  it('5. enforces single active cart per user (one_active_cart_per_user)', async () => {
    const userId = randomUUID();

    // First active cart
    await client.query(
      `INSERT INTO cart.carts (user_id, status) VALUES ($1, 'active')`,
      [userId],
    );

    // Second active cart for the same user should violate unique constraint
    await client.query('SAVEPOINT sp5');
    try {
      await expect(
        client.query(
          `INSERT INTO cart.carts (user_id, status) VALUES ($1, 'active')`,
          [userId],
        ),
      ).rejects.toThrow(/violates unique constraint "one_active_cart_per_user"/);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT sp5');
    }

    // But an abandoned cart for the same user is permitted
    const res = await client.query(
      `INSERT INTO cart.carts (user_id, status) VALUES ($1, 'abandoned') RETURNING id`,
      [userId],
    );
    expect(res.rows[0].id).toBeDefined();
  });

  it('6. enforces cart_items constraints (qty > 0 and unit_price >= 0)', async () => {
    const cartRes = await client.query(
      `INSERT INTO cart.carts (session_id) VALUES ('sess_items_test') RETURNING id`,
    );
    const cartId = cartRes.rows[0].id;
    const productId = randomUUID();

    // Negative qty
    await client.query('SAVEPOINT sp6_qty');
    try {
      await expect(
        client.query(
          `INSERT INTO cart.cart_items (cart_id, product_id, qty, unit_price, product_name)
           VALUES ($1, $2, 0, 19.99, 'Test Product')`,
          [cartId, productId],
        ),
      ).rejects.toThrow(/violates check constraint "cart_items_qty_check"/);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT sp6_qty');
    }

    // Negative unit_price
    await client.query('SAVEPOINT sp6_price');
    try {
      await expect(
        client.query(
          `INSERT INTO cart.cart_items (cart_id, product_id, qty, unit_price, product_name)
           VALUES ($1, $2, 1, -5.00, 'Test Product')`,
          [cartId, productId],
        ),
      ).rejects.toThrow(/violates check constraint "cart_items_unit_price_check"/);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT sp6_price');
    }
  });

  it('7. enforces unique cart items per variant including NULL variant (NULLS NOT DISTINCT)', async () => {
    const cartRes = await client.query(
      `INSERT INTO cart.carts (session_id) VALUES ('sess_nulls_test') RETURNING id`,
    );
    const cartId = cartRes.rows[0].id;
    const productId = randomUUID();

    // Insert first line without variant
    await client.query(
      `INSERT INTO cart.cart_items (cart_id, product_id, variant_id, qty, unit_price, product_name)
       VALUES ($1, $2, NULL, 1, 10.00, 'Item')`,
      [cartId, productId],
    );

    // Duplicate line without variant must violate unique constraint under NULLS NOT DISTINCT
    await expect(
      client.query(
        `INSERT INTO cart.cart_items (cart_id, product_id, variant_id, qty, unit_price, product_name)
         VALUES ($1, $2, NULL, 2, 10.00, 'Item')`,
        [cartId, productId],
      ),
    ).rejects.toThrow(
      /violates unique constraint "cart_items_cart_product_unique"/,
    );
  });

  it('8. cascades cart deletion to cart_items', async () => {
    const cartRes = await client.query(
      `INSERT INTO cart.carts (session_id) VALUES ('sess_cascade') RETURNING id`,
    );
    const cartId = cartRes.rows[0].id;
    const productId = randomUUID();

    await client.query(
      `INSERT INTO cart.cart_items (cart_id, product_id, qty, unit_price, product_name)
       VALUES ($1, $2, 1, 15.00, 'Cascade item')`,
      [cartId, productId],
    );

    // Delete cart
    await client.query(`DELETE FROM cart.carts WHERE id = $1`, [cartId]);

    // Items must be gone
    const itemsRes = await client.query(
      `SELECT * FROM cart.cart_items WHERE cart_id = $1`,
      [cartId],
    );
    expect(itemsRes.rows.length).toBe(0);
  });

  it('9. updates updated_at via trigger on cart modification', async () => {
    const pastTimestamp = '2000-01-01T00:00:00Z';
    const cartRes = await client.query(
      `INSERT INTO cart.carts (session_id, created_at, updated_at) 
       VALUES ('sess_trigger', $1, $1) RETURNING id, created_at, updated_at`,
      [pastTimestamp],
    );
    const cartId = cartRes.rows[0].id;

    const updateRes = await client.query(
      `UPDATE cart.carts SET status = 'abandoned' WHERE id = $1 RETURNING created_at, updated_at`,
      [cartId],
    );
    const updated = updateRes.rows[0];

    expect(new Date(updated.created_at).toISOString()).toBe(
      new Date(pastTimestamp).toISOString(),
    );
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
      new Date(pastTimestamp).getTime(),
    );
  });
});
