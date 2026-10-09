-- 0071_competitive_spawn_canary_controls.sql
-- Restart-safe per-group Incense window for competitive-spawn canary/testing workflows.

ALTER TABLE competitive_spawn_group_settings
  ADD COLUMN incense_until TIMESTAMPTZ NULL;

CREATE INDEX idx_competitive_spawn_group_settings_incense
  ON competitive_spawn_group_settings(incense_until)
  WHERE incense_until IS NOT NULL;

COMMENT ON COLUMN competitive_spawn_group_settings.incense_until IS
  'When in the future, lowers the current group activity target for competitive spawns. It never bypasses lifecycle/cooldown safety.';
