-- 0025_admin_api_rate_limit_buckets.sql
-- Durable, shared fixed-window budgets for authenticated Control Center traffic.

CREATE TABLE admin_api_rate_limit_buckets (
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  operation TEXT NOT NULL
    CHECK (operation IN ('session.read', 'player.search', 'player.read')),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, operation),
  CHECK (updated_at >= window_started_at)
);

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read operation keeps the budget shared across API instances without unbounded per-window row growth.';
