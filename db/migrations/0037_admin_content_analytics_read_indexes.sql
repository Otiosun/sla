-- Add bounded global content analytics read support for F8.4 without rewriting history.
CREATE INDEX idx_encounters_created_at
  ON encounters(created_at DESC);

CREATE INDEX idx_encounters_closed_at
  ON encounters(closed_at DESC)
  WHERE closed_at IS NOT NULL;

CREATE INDEX idx_capture_attempts_created_at
  ON capture_attempts(created_at DESC);

CREATE INDEX idx_capture_attempts_status_resolved_at
  ON capture_attempts(status, resolved_at DESC)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX idx_pokemon_xp_ledger_created_at
  ON pokemon_xp_ledger(created_at DESC)
  INCLUDE (awarded_xp);

CREATE INDEX idx_pokemon_evolution_claims_evolved_at
  ON pokemon_evolution_claims(evolved_at DESC);

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
      'economy.analytics.read',
      'content.analytics.read'
    )
  );

COMMENT ON INDEX idx_encounters_created_at IS
  'F8.4 global 30-day encounter creation aggregate support.';
COMMENT ON INDEX idx_encounters_closed_at IS
  'F8.4 global 30-day encounter closure aggregate support.';
COMMENT ON INDEX idx_capture_attempts_created_at IS
  'F8.4 global 30-day capture-attempt creation aggregate support.';
COMMENT ON INDEX idx_capture_attempts_status_resolved_at IS
  'F8.4 global 30-day terminal capture outcome aggregate support.';
COMMENT ON INDEX idx_pokemon_xp_ledger_created_at IS
  'F8.4 global 30-day XP award aggregate support with awarded_xp covering data.';
COMMENT ON INDEX idx_pokemon_evolution_claims_evolved_at IS
  'F8.4 global 30-day evolution aggregate support.';
