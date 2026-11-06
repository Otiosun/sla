-- A historical visit keeps its original area after the expedition moves.
ALTER TABLE solo_expeditions ADD CONSTRAINT solo_expedition_owner UNIQUE(id,player_id);
ALTER TABLE world_service_sessions DROP CONSTRAINT world_service_expedition_owner_area;
ALTER TABLE world_service_sessions ADD CONSTRAINT world_service_expedition_owner
  FOREIGN KEY(expedition_id,player_id) REFERENCES solo_expeditions(id,player_id);

-- INERT CANDIDATE. Binding does not consume time or reserve expedition quota.
CREATE TABLE solo_expedition_fishing_encounters (
  encounter_id UUID PRIMARY KEY REFERENCES encounters(id),
  attempt_id UUID NOT NULL UNIQUE REFERENCES fishing_attempts(id),
  expedition_id UUID NOT NULL,
  player_id UUID NOT NULL,
  area_id UUID NOT NULL,
  FOREIGN KEY (expedition_id,player_id) REFERENCES solo_expeditions(id,player_id)
);
CREATE INDEX solo_expedition_fishing_by_expedition ON solo_expedition_fishing_encounters(expedition_id);
