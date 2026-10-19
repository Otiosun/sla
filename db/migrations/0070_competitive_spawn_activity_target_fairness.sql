-- 0070_competitive_spawn_activity_target_fairness.sql
-- Persist the cycle target so participant churn can only make the active cycle easier, never harder.

ALTER TABLE competitive_spawn_activity_state
  ADD COLUMN target_milli INTEGER NULL
    CHECK (target_milli IS NULL OR target_milli > 0);

COMMENT ON COLUMN competitive_spawn_activity_state.target_milli IS
  'Persisted effective target for the current activity cycle. It is monotone non-increasing until a real cycle reset.';
