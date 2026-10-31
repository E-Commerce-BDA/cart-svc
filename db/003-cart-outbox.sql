BEGIN;

-- 003-cart-outbox.sql — transactional outbox for cart.updated.
-- Apply after 002-cart-settings.sql.
--
-- Every committed cart mutation writes exactly one row here inside its own
-- transaction, so the event and the cart state commit or roll back together.
-- The relay (from @ecom/messaging) publishes the stored envelope keyed by
-- cartId and flips status to 'published'.

CREATE TABLE IF NOT EXISTS cart.outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL UNIQUE,
  aggregate_type varchar(50)  NOT NULL,
  aggregate_id   uuid         NOT NULL,
  event_type     varchar(100) NOT NULL,
  -- The finished envelope, byte-for-byte what the relay publishes. Storing the
  -- payload instead would move contract validation to publish time.
  envelope       jsonb        NOT NULL,
  status         varchar(20)  NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','published','failed')),
  attempts       integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text         NULL,
  locked_until   timestamptz  NULL,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  published_at   timestamptz  NULL,
  CONSTRAINT outbox_aggregate_type_check CHECK (aggregate_type IN ('cart')),
  CONSTRAINT outbox_event_type_is_cart_updated CHECK (event_type = 'cart.updated'),
  -- The row may not disagree with its own envelope. No cast on envelope->>'id',
  -- so a malformed envelope fails the check instead of raising a cast error.
  CONSTRAINT outbox_envelope_type_matches CHECK (envelope->>'type' = event_type),
  CONSTRAINT outbox_envelope_id_matches   CHECK (envelope->>'id' = event_id::text)
);

-- The relay only ever claims pending rows in creation order.
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON cart.outbox (created_at) WHERE status = 'pending';

COMMIT;
