CREATE TABLE battle_participant_controllers (
  participant_id UUID PRIMARY KEY,
  battle_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PLAYER', 'NARRATOR', 'AUTO')),
  player_id UUID NULL REFERENCES players(id) ON DELETE RESTRICT,
  admin_principal_id UUID NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT battle_participant_controllers_participant_battle_fk
    FOREIGN KEY (participant_id, battle_id)
    REFERENCES battle_participants(id, battle_id) ON DELETE RESTRICT,
  CONSTRAINT battle_participant_controllers_kind_identity_check CHECK (
    (kind = 'PLAYER' AND player_id IS NOT NULL AND admin_principal_id IS NULL)
    OR (kind = 'NARRATOR' AND player_id IS NULL AND admin_principal_id IS NOT NULL)
    OR (kind = 'AUTO' AND player_id IS NULL AND admin_principal_id IS NULL)
  )
);

CREATE TABLE battle_participant_controller_events (
  id UUID PRIMARY KEY,
  battle_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  old_kind TEXT NULL CHECK (old_kind IN ('PLAYER', 'NARRATOR', 'AUTO')),
  old_player_id UUID NULL,
  old_admin_principal_id UUID NULL,
  new_kind TEXT NOT NULL CHECK (new_kind IN ('PLAYER', 'NARRATOR', 'AUTO')),
  new_player_id UUID NULL,
  new_admin_principal_id UUID NULL,
  previous_revision BIGINT NULL CHECK (previous_revision >= 0),
  resulting_revision BIGINT NOT NULL CHECK (resulting_revision >= 0),
  actor_admin_principal_id UUID NULL REFERENCES admin_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (participant_id, battle_id) REFERENCES battle_participants(id, battle_id) ON DELETE RESTRICT
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM battle_sides WHERE controller_kind = 'PLAYER' AND player_id IS NULL) THEN
    RAISE EXCEPTION 'cannot backfill PLAYER battle side without player_id';
  END IF;
END $$;

INSERT INTO battle_participant_controllers(participant_id,battle_id,kind,player_id)
SELECT participant.id, participant.battle_id,
  CASE WHEN side.controller_kind = 'PLAYER' THEN 'PLAYER' ELSE 'AUTO' END,
  CASE WHEN side.controller_kind = 'PLAYER' THEN side.player_id ELSE NULL END
FROM battle_participants participant JOIN battle_sides side ON side.battle_id=participant.battle_id AND side.id=participant.battle_side_id;

INSERT INTO battle_participant_controller_events(id,battle_id,participant_id,new_kind,new_player_id,resulting_revision)
SELECT gen_random_uuid(), battle_id, participant_id, kind, player_id, revision FROM battle_participant_controllers;
