-- 0028_pvp_challenge_lifecycle.sql
-- FLOW-003 Slice D: durable PVP challenge lifecycle and participant-aware Encounter ownership.
-- Migrations 0001-0027 are immutable.

ALTER TABLE encounters
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'PVE'
    CHECK (mode IN ('PVE', 'PVP'));

CREATE TABLE encounter_players (
  encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  side_no SMALLINT NOT NULL CHECK (side_no > 0),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'CHALLENGER', 'TARGET')),
  active BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, player_id),
  UNIQUE (encounter_id, side_no)
);

INSERT INTO encounter_players(encounter_id, player_id, side_no, role, active, created_at, updated_at)
SELECT id,
       player_id,
       1,
       'OWNER',
       status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE'),
       created_at,
       updated_at
FROM encounters;

CREATE UNIQUE INDEX uq_encounter_players_active_player
  ON encounter_players(player_id)
  WHERE active = TRUE;

CREATE INDEX idx_encounter_players_player_created
  ON encounter_players(player_id, created_at DESC);

CREATE OR REPLACE FUNCTION maintain_encounter_player_participation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_active BOOLEAN;
BEGIN
  next_active := NEW.status IN ('CREATED', 'PRESENTED', 'ENGAGED', 'CAPTURE_RESOLVING', 'IN_BATTLE');

  IF TG_OP = 'INSERT' THEN
    IF NEW.mode = 'PVE' THEN
      INSERT INTO encounter_players(encounter_id, player_id, side_no, role, active, created_at, updated_at)
      VALUES (NEW.id, NEW.player_id, 1, 'OWNER', next_active, NEW.created_at, NEW.updated_at);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE encounter_players
    SET active = next_active,
        updated_at = NEW.updated_at
    WHERE encounter_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounter_player_participation_insert
AFTER INSERT ON encounters
FOR EACH ROW EXECUTE FUNCTION maintain_encounter_player_participation();

CREATE TRIGGER trg_encounter_player_participation_status
AFTER UPDATE OF status ON encounters
FOR EACH ROW EXECUTE FUNCTION maintain_encounter_player_participation();

CREATE TABLE pvp_challenges (
  id UUID PRIMARY KEY,
  challenger_player_id UUID NOT NULL REFERENCES players(id),
  target_player_id UUID NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (
    status IN ('OPEN', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'STARTED')
  ),
  format_key TEXT NOT NULL CHECK (format_key = '1V1'),
  reach_policy TEXT NOT NULL CHECK (reach_policy = 'SAME_AREA'),
  area_id UUID NOT NULL REFERENCES areas(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  creation_idempotency_key TEXT NOT NULL
    CHECK (char_length(creation_idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  encounter_id UUID NULL UNIQUE REFERENCES encounters(id),
  battle_id UUID NULL UNIQUE REFERENCES battles(id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  CHECK (challenger_player_id <> target_player_id),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'OPEN'
      AND accepted_at IS NULL
      AND started_at IS NULL
      AND closed_at IS NULL
      AND encounter_id IS NULL
      AND battle_id IS NULL)
    OR
    (status = 'ACCEPTED'
      AND accepted_at IS NOT NULL
      AND started_at IS NULL
      AND closed_at IS NULL
      AND encounter_id IS NOT NULL
      AND battle_id IS NULL)
    OR
    (status = 'STARTED'
      AND accepted_at IS NOT NULL
      AND started_at IS NOT NULL
      AND closed_at IS NULL
      AND encounter_id IS NOT NULL
      AND battle_id IS NOT NULL)
    OR
    (status IN ('DECLINED', 'CANCELLED', 'EXPIRED')
      AND accepted_at IS NULL
      AND started_at IS NULL
      AND closed_at IS NOT NULL
      AND encounter_id IS NULL
      AND battle_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_pvp_challenge_creation_idempotency
  ON pvp_challenges(challenger_player_id, creation_idempotency_key);

CREATE UNIQUE INDEX uq_pvp_open_ordered_pair
  ON pvp_challenges(challenger_player_id, target_player_id, format_key)
  WHERE status = 'OPEN';

CREATE INDEX idx_pvp_challenges_target_status_created
  ON pvp_challenges(target_player_id, status, created_at DESC);

CREATE INDEX idx_pvp_challenges_expiration
  ON pvp_challenges(expires_at, id)
  WHERE status = 'OPEN';

COMMENT ON TABLE encounter_players IS
  'Participant-aware Encounter ownership. active enforces one incompatible Encounter participation per trainer across PVE and PVP.';

COMMENT ON TABLE pvp_challenges IS
  'Durable 1v1 PVP consent lifecycle with pinned release/ruleset/area and replay-safe creation identity.';
