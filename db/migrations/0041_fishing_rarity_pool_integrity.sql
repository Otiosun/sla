-- 0041_fishing_rarity_pool_integrity.sql
-- Restore exact Fishing semantics without invalidating historical attempts written under 0040.
-- Every new roll that resolves to an encounter rarity must reference an ADM-configured pool.

ALTER TABLE fishing_attempts
  ADD CONSTRAINT fishing_attempts_rarity_pool_integrity_check CHECK (
    (roll BETWEEN 1 AND 9 AND rarity IS NULL AND encounter_table_slug IS NULL)
    OR (roll BETWEEN 10 AND 14 AND rarity = 'COMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 15 AND 17 AND rarity = 'UNCOMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 18 AND 19 AND rarity = 'RARE' AND encounter_table_slug IS NOT NULL)
    OR (roll = 20 AND rarity = 'EXTREMELY_RARE' AND encounter_table_slug IS NOT NULL)
  ) NOT VALID;
