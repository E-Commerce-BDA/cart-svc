BEGIN;

-- 002-cart-settings.sql
-- Adds runtime cart behavior settings, their append-only audit log, and the
-- missing partial unique index that makes guest-cart creation race-safe.
-- Apply after 001-cart-schema.sql.

-- 1. Preflight the guest-session invariant before creating the unique index.
--    If duplicates already exist, fail loudly instead of leaving a half-applied
--    migration or silently skipping the uniqueness guarantee.
DO $$
DECLARE
  duplicate_sessions bigint;
BEGIN
  IF to_regclass('cart.one_active_cart_per_session') IS NULL THEN
    SELECT count(*)
      INTO duplicate_sessions
      FROM (
        SELECT session_id
          FROM cart.carts
         WHERE session_id IS NOT NULL
           AND status = 'active'
         GROUP BY session_id
        HAVING count(*) > 1
      ) duplicates;

    IF duplicate_sessions > 0 THEN
      RAISE EXCEPTION
        'Cannot create one_active_cart_per_session: % duplicate active guest session(s) exist; resolve them before re-running 002',
        duplicate_sessions;
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'cart'
       AND c.relname = 'one_active_cart_per_session'
       AND i.indisunique
  ) THEN
    RAISE EXCEPTION
      'cart.one_active_cart_per_session exists but is not a unique index';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_cart_per_session
  ON cart.carts (session_id)
  WHERE session_id IS NOT NULL AND status = 'active';

-- 2. Runtime settings document. JSONB stores overrides only; defaults and
--    validation live in the cart-svc code registry.
CREATE TABLE IF NOT EXISTS cart.settings (
  scope varchar(32) NOT NULL DEFAULT 'global',
  setting_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_pkey PRIMARY KEY (scope),
  CONSTRAINT settings_setting_values_object_check
    CHECK (jsonb_typeof(setting_values) = 'object')
);

-- Seed the single v1 scope without overwriting an existing admin document.
INSERT INTO cart.settings (scope)
VALUES ('global')
ON CONFLICT DO NOTHING;

-- 3. Append-only audit log. No FK to cart.settings: audit survives a future
--    scope cleanup. The app role gets INSERT + SELECT only in production.
CREATE TABLE IF NOT EXISTS cart.settings_audit (
  id uuid DEFAULT gen_random_uuid(),
  scope varchar(32) NOT NULL,
  version integer NOT NULL,
  old_values jsonb,
  new_values jsonb NOT NULL,
  changed_by uuid,
  request_id varchar(64),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_audit_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_cart_settings_audit_scope_changed_at
  ON cart.settings_audit (scope, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cart_settings_audit_changed_by
  ON cart.settings_audit (changed_by);

-- 4. Reuse the 001 trigger function; every settings update refreshes updated_at.
DROP TRIGGER IF EXISTS trg_cart_settings_updated_at ON cart.settings;
CREATE TRIGGER trg_cart_settings_updated_at
BEFORE UPDATE ON cart.settings
FOR EACH ROW EXECUTE FUNCTION cart.set_updated_at();

COMMIT;
