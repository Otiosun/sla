-- 0038_pokemon_roster_box_capacity.sql
-- World Services V1: make the database authoritative for 30-slot Pokemon boxes.

ALTER TABLE pokemon_roster_slots
  ADD CONSTRAINT pokemon_roster_box_slot_capacity_check
  CHECK (placement_kind <> 'BOX' OR slot_no BETWEEN 1 AND 30);
