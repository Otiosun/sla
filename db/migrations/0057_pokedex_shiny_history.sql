-- 0057_pokedex_shiny_history.sql
-- Preserve shiny discovery as historical Pokédex state instead of deriving it
-- from whichever shiny Pokemon currently remain in the player's roster.

ALTER TABLE player_pokedex_species
  ADD COLUMN shiny_seen_count BIGINT NOT NULL DEFAULT 0 CHECK (shiny_seen_count >= 0),
  ADD COLUMN shiny_caught_count BIGINT NOT NULL DEFAULT 0 CHECK (shiny_caught_count >= 0),
  ADD COLUMN first_shiny_seen_at TIMESTAMPTZ NULL,
  ADD COLUMN last_shiny_seen_at TIMESTAMPTZ NULL,
  ADD COLUMN first_shiny_caught_at TIMESTAMPTZ NULL,
  ADD COLUMN last_shiny_caught_at TIMESTAMPTZ NULL;

-- A currently or historically owned shiny instance is authoritative evidence that
-- the shiny variant was registered at least once. This conservative bootstrap does
-- not try to reconstruct encounter counts that were never persisted.
WITH shiny_owned AS (
  SELECT
    instance.owner_player_id AS player_id,
    form.species_id,
    MIN(COALESCE(instance.captured_at, instance.created_at)) AS first_registered_at
  FROM pokemon_instances instance
  JOIN pokemon_forms form ON form.id = instance.form_id
  WHERE instance.shiny = TRUE
  GROUP BY instance.owner_player_id, form.species_id
)
INSERT INTO player_pokedex_species(
  player_id,
  species_id,
  seen_count,
  caught_count,
  first_seen_at,
  last_seen_at,
  first_caught_at,
  last_caught_at,
  shiny_seen_count,
  shiny_caught_count,
  first_shiny_seen_at,
  last_shiny_seen_at,
  first_shiny_caught_at,
  last_shiny_caught_at
)
SELECT
  player_id,
  species_id,
  1,
  1,
  first_registered_at,
  first_registered_at,
  first_registered_at,
  first_registered_at,
  1,
  1,
  first_registered_at,
  first_registered_at,
  first_registered_at,
  first_registered_at
FROM shiny_owned
ON CONFLICT (player_id, species_id)
DO UPDATE SET
  shiny_seen_count = GREATEST(player_pokedex_species.shiny_seen_count, 1),
  shiny_caught_count = GREATEST(player_pokedex_species.shiny_caught_count, 1),
  first_shiny_seen_at = COALESCE(
    player_pokedex_species.first_shiny_seen_at,
    EXCLUDED.first_shiny_seen_at
  ),
  last_shiny_seen_at = COALESCE(
    player_pokedex_species.last_shiny_seen_at,
    EXCLUDED.last_shiny_seen_at
  ),
  first_shiny_caught_at = COALESCE(
    player_pokedex_species.first_shiny_caught_at,
    EXCLUDED.first_shiny_caught_at
  ),
  last_shiny_caught_at = COALESCE(
    player_pokedex_species.last_shiny_caught_at,
    EXCLUDED.last_shiny_caught_at
  ),
  revision = player_pokedex_species.revision + 1;

ALTER TABLE player_pokedex_species
  ADD CONSTRAINT player_pokedex_shiny_counts_check CHECK (
    shiny_caught_count <= shiny_seen_count
    AND shiny_seen_count <= seen_count
    AND shiny_caught_count <= caught_count
  ),
  ADD CONSTRAINT player_pokedex_shiny_seen_timestamps_check CHECK (
    (shiny_seen_count = 0 AND first_shiny_seen_at IS NULL AND last_shiny_seen_at IS NULL)
    OR
    (
      shiny_seen_count > 0
      AND first_shiny_seen_at IS NOT NULL
      AND last_shiny_seen_at IS NOT NULL
      AND first_shiny_seen_at <= last_shiny_seen_at
    )
  ),
  ADD CONSTRAINT player_pokedex_shiny_caught_timestamps_check CHECK (
    (shiny_caught_count = 0 AND first_shiny_caught_at IS NULL AND last_shiny_caught_at IS NULL)
    OR
    (
      shiny_caught_count > 0
      AND first_shiny_caught_at IS NOT NULL
      AND last_shiny_caught_at IS NOT NULL
      AND first_shiny_caught_at <= last_shiny_caught_at
    )
  );
