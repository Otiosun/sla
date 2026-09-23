-- Allow PVE allies on one real side while preserving PVP side uniqueness.
ALTER TABLE encounters ADD CONSTRAINT uq_encounters_id_mode UNIQUE (id, mode);
ALTER TABLE encounter_players
  DROP CONSTRAINT encounter_players_encounter_id_side_no_key,
  DROP CONSTRAINT encounter_players_role_check,
  ADD COLUMN encounter_mode TEXT NOT NULL DEFAULT 'PVE',
  ADD COLUMN pokemon_instance_ids UUID[] NULL;

UPDATE encounter_players participant SET encounter_mode = encounter.mode
FROM encounters encounter WHERE encounter.id = participant.encounter_id;

ALTER TABLE encounter_players
  ADD CONSTRAINT fk_encounter_players_mode FOREIGN KEY (encounter_id, encounter_mode)
    REFERENCES encounters(id, mode),
  ADD CONSTRAINT ck_encounter_players_role_mode CHECK (
    (encounter_mode = 'PVE' AND side_no = 1 AND role IN ('OWNER', 'ALLY')) OR
    (encounter_mode = 'PVP' AND role IN ('CHALLENGER', 'TARGET'))
  );
CREATE UNIQUE INDEX uq_encounter_players_pvp_side
  ON encounter_players(encounter_id, side_no) WHERE encounter_mode = 'PVP';
CREATE UNIQUE INDEX uq_encounter_players_pve_owner
  ON encounter_players(encounter_id) WHERE encounter_mode = 'PVE' AND role = 'OWNER';

CREATE FUNCTION guard_encounter_participant_snapshot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE parent_mode TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT mode INTO parent_mode FROM encounters WHERE id = NEW.encounter_id FOR UPDATE;
    NEW.encounter_mode := parent_mode;
  ELSE
    parent_mode := OLD.encounter_mode;
  END IF;
  IF parent_mode = 'PVE' AND EXISTS (
    SELECT 1 FROM encounter_snapshots WHERE encounter_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.encounter_id ELSE OLD.encounter_id END
  ) THEN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'PVE encounter participants are frozen' USING ERRCODE = '23514';
    END IF;
    IF (NEW.encounter_id, NEW.player_id, NEW.side_no, NEW.role, NEW.encounter_mode, NEW.pokemon_instance_ids)
      IS DISTINCT FROM
      (OLD.encounter_id, OLD.player_id, OLD.side_no, OLD.role, OLD.encounter_mode, OLD.pokemon_instance_ids) THEN
      RAISE EXCEPTION 'PVE encounter participants are frozen' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_encounter_participant_snapshot
BEFORE INSERT OR UPDATE OR DELETE ON encounter_players
FOR EACH ROW EXECUTE FUNCTION guard_encounter_participant_snapshot();

COMMENT ON COLUMN encounter_players.pokemon_instance_ids IS
  'TEAM roster identities frozen before the wild snapshot seals PVE participation; NULL preserves legacy initialization.';
