-- 0027_admin_api_mutation_prepare_rate_limit.sql
-- Expand the authenticated Admin API limiter allowlist for prepare-only mutations.

ALTER TABLE admin_api_rate_limit_buckets
  DROP CONSTRAINT admin_api_rate_limit_buckets_operation_check;

ALTER TABLE admin_api_rate_limit_buckets
  ADD CONSTRAINT admin_api_rate_limit_buckets_operation_check
  CHECK (operation IN ('session.read', 'player.search', 'player.read', 'mutation.prepare'));

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
