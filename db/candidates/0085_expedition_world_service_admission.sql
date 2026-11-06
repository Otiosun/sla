-- INERT CANDIDATE. Preserve Journey scene provenance; autonomous visits carry a real expedition FK.
ALTER TABLE solo_expeditions ADD CONSTRAINT solo_expedition_owner_area UNIQUE(id,player_id,area_id);
ALTER TABLE world_service_sessions ADD COLUMN expedition_id UUID NULL;
ALTER TABLE world_service_sessions ADD CONSTRAINT world_service_expedition_owner_area
  FOREIGN KEY(expedition_id,player_id,area_id) REFERENCES solo_expeditions(id,player_id,area_id);
ALTER TABLE world_service_sessions DROP CONSTRAINT world_service_sessions_check;
ALTER TABLE world_service_sessions ADD CONSTRAINT world_service_admission_provenance
  CHECK(service_kind='PC' OR scene_proof_id IS NOT NULL OR expedition_id IS NOT NULL);
ALTER TABLE world_service_sessions ADD CONSTRAINT world_service_admission_single_source
  CHECK(expedition_id IS NULL OR scene_proof_id IS NULL);
CREATE FUNCTION check_expedition_service_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.expedition_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM solo_expeditions expedition JOIN player_locations location
      ON location.player_id=expedition.player_id AND location.area_id=expedition.area_id
    WHERE expedition.id=NEW.expedition_id AND expedition.player_id=NEW.player_id
      AND expedition.area_id=NEW.area_id AND expedition.phase='ACTIVE'
  ) THEN RAISE EXCEPTION 'Expedition visit requires an active, co-located expedition'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expedition_service_admission BEFORE INSERT ON world_service_sessions
  FOR EACH ROW EXECUTE FUNCTION check_expedition_service_admission();
