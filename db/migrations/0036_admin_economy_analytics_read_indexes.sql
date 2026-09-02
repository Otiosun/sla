-- Add bounded global economy analytics read support without rewriting history.
CREATE INDEX idx_wallet_ledger_created_currency
  ON wallet_ledger(created_at DESC, currency_id);

CREATE INDEX idx_inventory_ledger_created
  ON inventory_ledger(created_at DESC);

-- Forward-only repair: F8.2 introduced player.activity.read in the application
-- limiter without extending the durable PostgreSQL allowlist. F8.3 adds both
-- analytics reads here so an authenticated request cannot fail at bucket insert.
ALTER TABLE admin_api_rate_limit_buckets
  DROP CONSTRAINT admin_api_rate_limit_buckets_operation_check;

ALTER TABLE admin_api_rate_limit_buckets
  ADD CONSTRAINT admin_api_rate_limit_buckets_operation_check
  CHECK (
    operation IN (
      'session.read',
      'player.search',
      'player.read',
      'player.activity.read',
      'economy.analytics.read',
      'mutation.prepare',
      'content.search',
      'runtime.health.read',
      'messaging.operations.read',
      'incident.read',
      'audit.read'
    )
  );

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
