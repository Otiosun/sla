-- 0040_fishing_optional_rarity_pools.sql
-- Allow ADM-optional rare tiers to consume a Fishing attempt without forcing a fabricated encounter pool.

ALTER TABLE fishing_attempts
  DROP CONSTRAINT fishing_attempts_roll_outcome_check;

ALTER TABLE fishing_attempts
  ADD CONSTRAINT fishing_attempts_roll_outcome_check CHECK (
    (roll BETWEEN 1 AND 9 AND rarity IS NULL AND encounter_table_slug IS NULL)
    OR (roll BETWEEN 10 AND 14 AND rarity = 'COMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 15 AND 17 AND rarity = 'UNCOMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 18 AND 19 AND rarity = 'RARE')
    OR (roll = 20 AND rarity = 'EXTREMELY_RARE')
  );
