-- Keep legacy PVP windows readable while allowing participant-scoped human snapshots.
ALTER TABLE battle_turn_windows ADD COLUMN required_controllers JSONB NULL
  CHECK (required_controllers IS NULL OR jsonb_typeof(required_controllers) = 'array');

ALTER TABLE battle_turn_submissions
  ALTER COLUMN player_id DROP NOT NULL,
  ADD COLUMN admin_principal_id UUID NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  ADD COLUMN controller_revision BIGINT NULL CHECK (controller_revision >= 0),
  ADD CONSTRAINT battle_turn_submissions_human_identity CHECK (
    (player_id IS NOT NULL AND admin_principal_id IS NULL)
    OR (player_id IS NULL AND admin_principal_id IS NOT NULL AND controller_revision IS NOT NULL)
  ),
  DROP CONSTRAINT battle_turn_submissions_revision_unique;

DROP INDEX battle_turn_submissions_one_active_per_player;
CREATE UNIQUE INDEX battle_turn_submissions_legacy_revision_unique
  ON battle_turn_submissions(turn_window_id, player_id, submission_revision)
  WHERE controller_revision IS NULL;
CREATE UNIQUE INDEX battle_turn_submissions_one_active_per_player
  ON battle_turn_submissions(turn_window_id, player_id)
  WHERE status = 'ACTIVE' AND controller_revision IS NULL;
CREATE UNIQUE INDEX battle_turn_submissions_controller_revision_unique
  ON battle_turn_submissions(turn_window_id, actor_participant_id, submission_revision)
  WHERE controller_revision IS NOT NULL;
CREATE UNIQUE INDEX battle_turn_submissions_one_active_per_controller
  ON battle_turn_submissions(turn_window_id, actor_participant_id)
  WHERE status = 'ACTIVE' AND controller_revision IS NOT NULL;
