-- 0007_battle_resolution_integrity.sql
-- Durable battle-resolution causality, replay identity and battle content flags.
-- Migrations 0001-0006 are immutable; this migration only extends their contracts.

ALTER TABLE battle_actions
  ADD COLUMN correlation_id UUID NULL,
  ADD COLUMN resolved_battle_version BIGINT NULL;

UPDATE battle_actions
SET correlation_id = gen_random_uuid()
WHERE correlation_id IS NULL;

ALTER TABLE battle_actions
  ALTER COLUMN correlation_id SET NOT NULL,
  ADD CONSTRAINT battle_actions_resolved_version_nonnegative
    CHECK (resolved_battle_version IS NULL OR resolved_battle_version >= 0),
  ADD CONSTRAINT battle_actions_lifecycle_coherent
    CHECK (
      (status IN ('RECEIVED', 'ACCEPTED') AND resolved_at IS NULL AND resolved_battle_version IS NULL)
      OR (status = 'REJECTED' AND resolved_at IS NOT NULL AND resolved_battle_version IS NULL)
      OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_battle_version IS NOT NULL)
    ) NOT VALID;

-- Existing databases predate resolved_battle_version. No historical row can be assigned a
-- trustworthy produced version retroactively, so fail closed instead of inventing one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM battle_actions WHERE status = 'RESOLVED') THEN
    RAISE EXCEPTION
      'Cannot apply 0007 with legacy RESOLVED battle_actions lacking resolved_battle_version';
  END IF;
END
$$;

ALTER TABLE battle_actions
  VALIDATE CONSTRAINT battle_actions_lifecycle_coherent;

ALTER TABLE battle_actions
  ADD CONSTRAINT battle_actions_resolved_snapshot_fk
    FOREIGN KEY (battle_id, resolved_battle_version)
    REFERENCES battle_state_snapshots(battle_id, version)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE battles
  ADD CONSTRAINT battles_lifecycle_coherent
    CHECK (
      (status IN ('WON', 'LOST', 'FLED', 'DRAW', 'CANCELLED') AND ended_at IS NOT NULL)
      OR (status IN ('CREATED', 'ACTIVE', 'RESOLVING_TURN') AND ended_at IS NULL)
    ) NOT VALID;

ALTER TABLE battles
  VALIDATE CONSTRAINT battles_lifecycle_coherent;

ALTER TABLE battle_events
  ALTER COLUMN correlation_id DROP NOT NULL;

UPDATE battle_events
SET correlation_id = gen_random_uuid()
WHERE correlation_id IS NULL;

ALTER TABLE battle_events
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE move_revisions
  ADD COLUMN flags JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(flags) = 'object');

CREATE INDEX idx_battle_actions_battle_version
  ON battle_actions(battle_id, expected_battle_version, created_at);

CREATE INDEX idx_battle_events_correlation
  ON battle_events(correlation_id, occurred_at);
