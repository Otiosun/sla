-- 0031_admin_api_content_search_rate_limit.sql
-- Keep the PostgreSQL rate-limit allowlist aligned with the read-only Content Studio routes.

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
      'content.search'
    )
  );

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
