CREATE TABLE battle_turn_windows (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL,
  battle_version BIGINT NOT NULL CHECK (battle_version >= 0),
  turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
  status TEXT NOT NULL CHECK (status IN ('COLLECTING', 'LOCKED', 'COMMITTED', 'CANCELLED')),
  opened_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ NULL,
  committed_at TIMESTAMPTZ NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  resolution_correlation_id UUID NULL,
  resolved_battle_version BIGINT NULL CHECK (
    resolved_battle_version IS NULL OR resolved_battle_version >= 0
  ),
  CONSTRAINT battle_turn_windows_battle_fk
    FOREIGN KEY (battle_id) REFERENCES battles(id) ON DELETE RESTRICT,
  CONSTRAINT battle_turn_windows_snapshot_fk
    FOREIGN KEY (battle_id, battle_version)
    REFERENCES battle_state_snapshots(battle_id, version) ON DELETE RESTRICT,
  CONSTRAINT battle_turn_windows_resolved_snapshot_fk
    FOREIGN KEY (battle_id, resolved_battle_version)
    REFERENCES battle_state_snapshots(battle_id, version) ON DELETE RESTRICT,
  CONSTRAINT battle_turn_windows_version_unique UNIQUE (battle_id, battle_version),
  CONSTRAINT battle_turn_windows_deadline_check CHECK (deadline_at > opened_at),
  CONSTRAINT battle_turn_windows_lifecycle_check CHECK (
    (
      status = 'COLLECTING'
      AND locked_at IS NULL
      AND committed_at IS NULL
      AND resolution_correlation_id IS NULL
      AND resolved_battle_version IS NULL
    )
    OR (
      status = 'LOCKED'
      AND locked_at IS NOT NULL
      AND committed_at IS NULL
      AND resolution_correlation_id IS NULL
      AND resolved_battle_version IS NULL
    )
    OR (
      status = 'COMMITTED'
      AND locked_at IS NOT NULL
      AND committed_at IS NOT NULL
      AND resolution_correlation_id IS NOT NULL
      AND resolved_battle_version IS NOT NULL
    )
    OR (
      status = 'CANCELLED'
      AND committed_at IS NULL
      AND resolution_correlation_id IS NULL
      AND resolved_battle_version IS NULL
    )
  )
);

CREATE TABLE battle_turn_window_required_players (
  turn_window_id UUID NOT NULL REFERENCES battle_turn_windows(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  side_no SMALLINT NOT NULL CHECK (side_no > 0),
  PRIMARY KEY (turn_window_id, player_id),
  CONSTRAINT battle_turn_window_required_players_side_unique
    UNIQUE (turn_window_id, side_no)
);

CREATE TABLE battle_turn_submissions (
  id UUID PRIMARY KEY,
  turn_window_id UUID NOT NULL REFERENCES battle_turn_windows(id) ON DELETE RESTRICT,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  side_no SMALLINT NOT NULL CHECK (side_no > 0),
  actor_participant_id UUID NOT NULL REFERENCES battle_participants(id) ON DELETE RESTRICT,
  expected_battle_version BIGINT NOT NULL CHECK (expected_battle_version >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL CHECK (action_type IN ('USE_MOVE', 'SWITCH', 'USE_ITEM', 'FLEE')),
  action_payload JSONB NOT NULL CHECK (jsonb_typeof(action_payload) = 'object'),
  submission_revision BIGINT NOT NULL CHECK (submission_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'COMMITTED', 'REJECTED')),
  submitted_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT battle_turn_submissions_revision_unique
    UNIQUE (turn_window_id, player_id, submission_revision),
  CONSTRAINT battle_turn_submissions_required_player_fk
    FOREIGN KEY (turn_window_id, player_id)
    REFERENCES battle_turn_window_required_players(turn_window_id, player_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX battle_turn_submissions_one_active_per_player
  ON battle_turn_submissions(turn_window_id, player_id)
  WHERE status = 'ACTIVE';

CREATE INDEX battle_turn_windows_deadline_idx
  ON battle_turn_windows(status, deadline_at)
  WHERE status = 'COLLECTING';

CREATE INDEX battle_turn_submissions_window_idx
  ON battle_turn_submissions(turn_window_id, player_id, submission_revision);
