-- 0037_admin_api_session_logout_and_player_activity_rate_limits.sql
-- Keep the PostgreSQL rate-limit allowlist aligned with every currently routed Admin API operation.

ALTER TABLE admin_api_rate_limit_buckets
  DROP CONSTRAINT admin_api_rate_limit_buckets_operation_check;

ALTER TABLE admin_api_rate_limit_buckets
  ADD CONSTRAINT admin_api_rate_limit_buckets_operation_check
  CHECK (
    operation IN (
      'session.read',
      'session.logout',
      'player.search',
      'player.read',
      'player.activity.read',
      'economy.analytics.read',
      'content.search',
      'runtime.health.read',
      'messaging.operations.read',
      'incident.read',
      'audit.read',
      'mutation.prepare'
    )
  );

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read, logout, or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
