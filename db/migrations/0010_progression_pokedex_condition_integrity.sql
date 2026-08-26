-- 0010_progression_pokedex_condition_integrity.sql
-- Phase 11 canonical hardening: Pokédex timestamp coherence and
-- server-authoritative per-Pokemon evolution condition flags.
-- Migrations 0001-0009 are immutable.

-- Normalize any historical rows before enforcing timestamp/count coherence.
UPDATE player_pokedex_species
SET first_seen_at = CASE WHEN seen_count > 0 THEN COALESCE(first_seen_at, now()) ELSE NULL END,
    last_seen_at = CASE WHEN seen_count > 0 THEN COALESCE(last_seen_at, first_seen_at, now()) ELSE NULL END,
    first_caught_at = CASE WHEN caught_count > 0 THEN COALESCE(first_caught_at, now()) ELSE NULL END,
    last_caught_at = CASE WHEN caught_count > 0 THEN COALESCE(last_caught_at, first_caught_at, now()) ELSE NULL END;

ALTER TABLE player_pokedex_species
  ADD CONSTRAINT player_pokedex_seen_timestamps_check CHECK (
    (seen_count = 0 AND first_seen_at IS NULL AND last_seen_at IS NULL)
    OR
    (seen_count > 0 AND first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL AND first_seen_at <= last_seen_at)
  ),
  ADD CONSTRAINT player_pokedex_caught_timestamps_check CHECK (
    (caught_count = 0 AND first_caught_at IS NULL AND last_caught_at IS NULL)
    OR
    (caught_count > 0 AND first_caught_at IS NOT NULL AND last_caught_at IS NOT NULL AND first_caught_at <= last_caught_at)
  );

CREATE TABLE pokemon_evolution_condition_flags (
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  condition_key TEXT NOT NULL CHECK (condition_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (pokemon_instance_id, condition_key),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_pokemon_evolution_condition_flags_status
  ON pokemon_evolution_condition_flags(pokemon_instance_id, status, condition_key);
CREATE INDEX idx_pokemon_evolution_condition_flags_correlation
  ON pokemon_evolution_condition_flags(correlation_id, granted_at DESC);
