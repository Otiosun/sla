-- 0064_player_entitlements.sql
-- Canonical commercial entitlement state + append-only idempotent grant ledger.
-- Product/order mapping is intentionally deferred: this migration defines durable primitives only.

CREATE TABLE entitlement_definitions (
  key TEXT PRIMARY KEY CHECK (key ~ '^[A-Z0-9][A-Z0-9_.:-]{1,127}$'),
  grant_model TEXT NOT NULL CHECK (grant_model IN ('PERMANENT', 'TIMED')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, grant_model)
);

CREATE TABLE player_entitlements (
  player_id UUID NOT NULL REFERENCES players(id),
  entitlement_key TEXT NOT NULL,
  grant_model TEXT NOT NULL,
  administrative_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (administrative_status IN ('ACTIVE', 'REVOKED')),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, entitlement_key),
  FOREIGN KEY (entitlement_key, grant_model)
    REFERENCES entitlement_definitions(key, grant_model),
  CHECK (
    (grant_model = 'PERMANENT' AND expires_at IS NULL)
    OR
    (grant_model = 'TIMED' AND expires_at IS NOT NULL AND expires_at > starts_at)
  )
);

CREATE INDEX idx_player_entitlements_active_lookup
  ON player_entitlements(player_id, administrative_status, entitlement_key);

CREATE INDEX idx_player_entitlements_expiry
  ON player_entitlements(expires_at)
  WHERE grant_model = 'TIMED' AND administrative_status = 'ACTIVE';

CREATE TABLE entitlement_grants (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  entitlement_key TEXT NOT NULL,
  grant_model TEXT NOT NULL,
  duration_seconds BIGINT NULL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  source_type TEXT NOT NULL CHECK (char_length(source_type) BETWEEN 1 AND 64),
  source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 256),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'ADMIN')),
  actor_id UUID NULL,
  idempotency_scope TEXT NOT NULL CHECK (char_length(idempotency_scope) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  previous_status TEXT NULL CHECK (previous_status IS NULL OR previous_status IN ('ACTIVE', 'REVOKED')),
  previous_starts_at TIMESTAMPTZ NULL,
  previous_expires_at TIMESTAMPTZ NULL,
  resulting_starts_at TIMESTAMPTZ NOT NULL,
  resulting_expires_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  correlation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (entitlement_key, grant_model)
    REFERENCES entitlement_definitions(key, grant_model),
  UNIQUE (idempotency_scope, idempotency_key),
  CHECK (
    (grant_model = 'PERMANENT' AND duration_seconds IS NULL AND resulting_expires_at IS NULL)
    OR
    (grant_model = 'TIMED' AND duration_seconds IS NOT NULL AND resulting_expires_at IS NOT NULL)
  ),
  CHECK (resulting_expires_at IS NULL OR resulting_expires_at > resulting_starts_at)
);

CREATE INDEX idx_entitlement_grants_player_created
  ON entitlement_grants(player_id, created_at DESC);

CREATE INDEX idx_entitlement_grants_player_key_created
  ON entitlement_grants(player_id, entitlement_key, created_at DESC);

COMMENT ON TABLE entitlement_definitions IS
  'Canonical entitlement keys and grant semantics. Commercial product mapping lives outside this primitive.';
COMMENT ON TABLE player_entitlements IS
  'Materialized current entitlement state. Timed activity also requires expires_at > now().';
COMMENT ON TABLE entitlement_grants IS
  'Append-only idempotent grant ledger. Reprocessing the same source key must never double-grant.';
