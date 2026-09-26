-- 0039_fishing_attempts.sql
-- World Services V1: durable, replay-safe daily Fishing attempt authority.

CREATE TABLE fishing_attempts (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  area_id UUID NOT NULL REFERENCES areas(id),
  fishing_day DATE NOT NULL,
  attempt_no SMALLINT NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  roll SMALLINT NOT NULL CHECK (roll BETWEEN 1 AND 20),
  rarity TEXT,
  fishing_point_name TEXT NOT NULL CHECK (
    char_length(btrim(fishing_point_name)) BETWEEN 1 AND 120
  ),
  encounter_table_slug TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fishing_attempts_rarity_check CHECK (
    rarity IS NULL OR rarity IN ('COMMON', 'UNCOMMON', 'RARE', 'EXTREMELY_RARE')
  ),
  CONSTRAINT fishing_attempts_roll_outcome_check CHECK (
    (roll BETWEEN 1 AND 9 AND rarity IS NULL AND encounter_table_slug IS NULL)
    OR (roll BETWEEN 10 AND 14 AND rarity = 'COMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 15 AND 17 AND rarity = 'UNCOMMON' AND encounter_table_slug IS NOT NULL)
    OR (roll BETWEEN 18 AND 19 AND rarity = 'RARE' AND encounter_table_slug IS NOT NULL)
    OR (roll = 20 AND rarity = 'EXTREMELY_RARE' AND encounter_table_slug IS NOT NULL)
  ),
  CONSTRAINT fishing_attempts_table_slug_check CHECK (
    encounter_table_slug IS NULL
    OR encounter_table_slug ~ '^[a-z0-9][a-z0-9._-]{0,95}$'
  ),
  UNIQUE (player_id, idempotency_key),
  UNIQUE (player_id, fishing_day, attempt_no)
);

CREATE INDEX idx_fishing_attempts_player_day
  ON fishing_attempts(player_id, fishing_day, attempt_no);

CREATE INDEX idx_fishing_attempts_release_area
  ON fishing_attempts(content_release_id, area_id, created_at);
