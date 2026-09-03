-- Add bounded global gameplay analytics read support without rewriting migration history.
CREATE INDEX idx_encounters_created_player
  ON encounters(created_at DESC, player_id);

CREATE INDEX idx_encounters_closed_status_player
  ON encounters(closed_at DESC, status, player_id)
  WHERE closed_at IS NOT NULL;

CREATE INDEX idx_capture_attempts_resolved_status_player
  ON capture_attempts(resolved_at DESC, status, player_id)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX idx_trainer_progress_ledger_created_player
  ON trainer_progress_ledger(created_at DESC, player_id);

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
      'gameplay.analytics.read',
      'content.search',
      'runtime.health.read',
      'messaging.operations.read',
      'incident.read',
      'audit.read',
      'mutation.prepare'
    )
  );

COMMENT ON TABLE admin_api_rate_limit_buckets IS
  'Mutable operational counters for authenticated Admin API rate limiting. One row per principal and allowlisted read or prepare-only mutation operation keeps the budget shared across API instances without unbounded per-window row growth.';
