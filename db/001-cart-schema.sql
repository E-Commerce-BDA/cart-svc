BEGIN;

CREATE SCHEMA IF NOT EXISTS cart;

-- 1. carts
CREATE TABLE IF NOT EXISTS cart.carts (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid,
  session_id varchar(64),
  status varchar(20) DEFAULT 'active' NOT NULL,
  last_activity_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT carts_pkey PRIMARY KEY (id),
  CONSTRAINT carts_status_check CHECK (status IN ('active', 'abandoned', 'converted')),
  CONSTRAINT carts_owner_check CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_cart_per_user 
  ON cart.carts (user_id) 
  WHERE user_id IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_carts_session_id 
  ON cart.carts (session_id);

CREATE INDEX IF NOT EXISTS idx_carts_abandoned 
  ON cart.carts (status, last_activity_at) 
  WHERE status = 'active';

-- 2. cart_items
CREATE TABLE IF NOT EXISTS cart.cart_items (
  id uuid DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  qty integer NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  product_name varchar(255) NOT NULL,
  product_slug varchar(280),
  image_url varchar(2048),
  variant_label varchar(150),
  added_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT cart_items_pkey PRIMARY KEY (id),
  CONSTRAINT cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES cart.carts(id) ON DELETE CASCADE,
  CONSTRAINT cart_items_qty_check CHECK (qty > 0),
  CONSTRAINT cart_items_unit_price_check CHECK (unit_price >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cart_items_cart_product_unique 
  ON cart.cart_items (cart_id, product_id, variant_id) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_cart_items_product_id 
  ON cart.cart_items (product_id);

-- 3. wishlists
CREATE TABLE IF NOT EXISTS cart.wishlists (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT wishlists_pkey PRIMARY KEY (id),
  CONSTRAINT wishlists_user_id_key UNIQUE (user_id)
);

-- 4. wishlist_items
CREATE TABLE IF NOT EXISTS cart.wishlist_items (
  id uuid DEFAULT gen_random_uuid(),
  wishlist_id uuid NOT NULL,
  product_id uuid NOT NULL,
  added_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT wishlist_items_pkey PRIMARY KEY (id),
  CONSTRAINT wishlist_items_wishlist_id_fkey FOREIGN KEY (wishlist_id) REFERENCES cart.wishlists(id) ON DELETE CASCADE,
  CONSTRAINT wishlist_items_unique UNIQUE (wishlist_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_items_wishlist_id 
  ON cart.wishlist_items (wishlist_id);

-- 5. triggers
CREATE OR REPLACE FUNCTION cart.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_carts_updated_at ON cart.carts;
CREATE TRIGGER trg_carts_updated_at
BEFORE UPDATE ON cart.carts
FOR EACH ROW EXECUTE FUNCTION cart.set_updated_at();

DROP TRIGGER IF EXISTS trg_wishlists_updated_at ON cart.wishlists;
CREATE TRIGGER trg_wishlists_updated_at
BEFORE UPDATE ON cart.wishlists
FOR EACH ROW EXECUTE FUNCTION cart.set_updated_at();

COMMIT;
