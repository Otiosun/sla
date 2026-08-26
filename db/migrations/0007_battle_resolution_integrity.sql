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

UPDATE battle_events
SET correlation_id = gen_random_uuid()
WHERE correlation_id IS NULL;

ALTER TABLE battle_events
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE move_revisions
  ADD COLUMN flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT move_revisions_battle_flags_shape
    CHECK (
      flags = '{}'::jsonb
      OR (
        jsonb_typeof(flags) = 'object'
        AND flags ->> 'schemaVersion' = '1'
        AND jsonb_typeof(flags -> 'makesContact') = 'boolean'
        AND (SELECT count(*) FROM jsonb_object_keys(flags)) = 2
      )
    );

-- Catalog clone code written before battle flags intentionally omits the new column. Preserve
-- snapshot semantics at the database boundary: a child release inherits the parent's move flags
-- when the insert uses the legacy/default empty object. Explicit non-empty flags in a DRAFT child
-- still win and can be deliberately changed before validation.
CREATE OR REPLACE FUNCTION inherit_move_revision_battle_flags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id UUID;
  inherited_flags JSONB;
BEGIN
  IF NEW.flags <> '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  SELECT parent_release_id INTO parent_id
  FROM content_releases
  WHERE id = NEW.content_release_id;

  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT flags INTO inherited_flags
  FROM move_revisions
  WHERE content_release_id = parent_id
    AND move_id = NEW.move_id;

  IF inherited_flags IS NOT NULL THEN
    NEW.flags := inherited_flags;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_move_revisions_inherit_battle_flags
BEFORE INSERT ON move_revisions
FOR EACH ROW EXECUTE FUNCTION inherit_move_revision_battle_flags();

CREATE INDEX idx_battle_actions_battle_version
  ON battle_actions(battle_id, expected_battle_version, created_at);

CREATE INDEX idx_battle_events_correlation
  ON battle_events(correlation_id, occurred_at);
