-- 0074_premium_orders.sql
-- Server-authoritative premium catalog, order, payment-event and fulfillment ledgers.
-- Payment confirmation and fulfillment are deliberately separate so webhook retries
-- and fulfillment retries cannot double-deliver paid products.

CREATE SEQUENCE premium_order_human_seq AS BIGINT START WITH 1;

CREATE TABLE premium_product_definitions (
  sku TEXT PRIMARY KEY CHECK (sku ~ '^[A-Z0-9][A-Z0-9_.:-]{1,127}$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  fulfillment_kind TEXT NOT NULL
    CHECK (fulfillment_kind IN ('ENTITLEMENT', 'POKEMON_PACKAGE', 'MANUAL')),
  fulfillment_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(fulfillment_payload) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE premium_orders (
  id UUID PRIMARY KEY,
  human_id TEXT NOT NULL UNIQUE CHECK (human_id ~ '^PB-[0-9]{8,20}$'),
  player_id UUID NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'APPLIED', 'CANCELLED')),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  idempotency_scope TEXT NOT NULL CHECK (char_length(idempotency_scope) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  correlation_id UUID NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ NULL,
  applied_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  UNIQUE (idempotency_scope, idempotency_key),
  CHECK ((status <> 'PENDING') OR (paid_at IS NULL AND applied_at IS NULL AND cancelled_at IS NULL)),
  CHECK ((status <> 'PAID') OR (paid_at IS NOT NULL AND applied_at IS NULL AND cancelled_at IS NULL)),
  CHECK ((status <> 'APPLIED') OR (paid_at IS NOT NULL AND applied_at IS NOT NULL AND cancelled_at IS NULL)),
  CHECK ((status <> 'CANCELLED') OR (applied_at IS NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX idx_premium_orders_player_created
  ON premium_orders(player_id, created_at DESC);
CREATE INDEX idx_premium_orders_status_created
  ON premium_orders(status, created_at);

CREATE TABLE premium_order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES premium_orders(id),
  line_no SMALLINT NOT NULL CHECK (line_no BETWEEN 1 AND 32),
  product_sku TEXT NOT NULL CHECK (product_sku ~ '^[A-Z0-9][A-Z0-9_.:-]{1,127}$'),
  product_title_snapshot TEXT NOT NULL CHECK (char_length(product_title_snapshot) BETWEEN 1 AND 160),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents > 0),
  quantity SMALLINT NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total_cents BIGINT NOT NULL CHECK (line_total_cents > 0),
  fulfillment_kind_snapshot TEXT NOT NULL
    CHECK (fulfillment_kind_snapshot IN ('ENTITLEMENT', 'POKEMON_PACKAGE', 'MANUAL')),
  fulfillment_payload_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(fulfillment_payload_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_no),
  UNIQUE (order_id, product_sku),
  CHECK (line_total_cents = unit_price_cents * quantity)
);

CREATE INDEX idx_premium_order_items_order
  ON premium_order_items(order_id, line_no);

CREATE TABLE premium_payment_events (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES premium_orders(id),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  external_event_id TEXT NOT NULL CHECK (char_length(external_event_id) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL CHECK (event_type IN ('PAID', 'CANCELLED')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_digest TEXT NULL CHECK (payload_digest IS NULL OR payload_digest ~ '^[0-9a-f]{64}$'),
  correlation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

CREATE INDEX idx_premium_payment_events_order_created
  ON premium_payment_events(order_id, created_at DESC);

CREATE TABLE premium_fulfillment_events (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES premium_orders(id),
  order_item_id UUID NOT NULL REFERENCES premium_order_items(id),
  fulfillment_key TEXT NOT NULL UNIQUE CHECK (char_length(fulfillment_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_item_id)
);

CREATE INDEX idx_premium_fulfillment_events_order
  ON premium_fulfillment_events(order_id, created_at);

COMMENT ON TABLE premium_product_definitions IS
  'Server-authoritative premium product catalog. The client may request a SKU but never supplies authoritative price or fulfillment semantics.';
COMMENT ON TABLE premium_orders IS
  'Premium order header with public human ID and technical UUID. Payment and fulfillment are independent state transitions.';
COMMENT ON TABLE premium_order_items IS
  'Immutable product/price/fulfillment snapshots captured from the server catalog at order creation.';
COMMENT ON TABLE premium_payment_events IS
  'Webhook-compatible idempotent payment event ledger keyed by provider plus external event ID.';
COMMENT ON TABLE premium_fulfillment_events IS
  'One durable fulfillment result per order item; fulfillment_key also binds retries to the same semantic delivery.';
