-- Add bounded global economy analytics read support without rewriting history.
CREATE INDEX idx_wallet_ledger_created_currency
  ON wallet_ledger(created_at DESC, currency_id);

CREATE INDEX idx_inventory_ledger_created
  ON inventory_ledger(created_at DESC);

ALTER TABLE admin_api_rate_limit_buckets
  DROP CONSTRAINT admin_api_rate_limit_buckets_operation_check;

ALTER TABLE admin_api_rate_limit_buckets
  ADD CONSTRAINT admin_api_rate_limit_buckets_operation_check
  CHECK (
    operation IN (
      'session.read',
      'player.search',
      'player.read',
      'mutation.prepare',
      'content.search',
      'runtime.health.read',
      'messaging.operations.read',
      'incident.read',
      'audit.read',
      'economy.analytics.read'
    )
  );

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
