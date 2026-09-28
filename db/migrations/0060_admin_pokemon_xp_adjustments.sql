-- 0060_admin_pokemon_xp_adjustments.sql
-- Audited signed Pokemon XP adjustments for administrative rewards/corrections.
-- Positive awards may trigger normal level-up side effects. Negative adjustments preserve
-- historical moves/forms and only move the stored level/XP state backwards.

CREATE TABLE pokemon_xp_adjustment_claims (
  id UUID PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  player_id UUID NOT NULL REFERENCES players(id),
  requested_delta BIGINT NOT NULL CHECK (requested_delta <> 0),
  applied_delta BIGINT NOT NULL,
  before_level SMALLINT NOT NULL CHECK (before_level BETWEEN 1 AND 100),
  after_level SMALLINT NOT NULL CHECK (after_level BETWEEN 1 AND 100),
  before_xp BIGINT NOT NULL CHECK (before_xp >= 0),
  after_xp BIGINT NOT NULL CHECK (after_xp >= 0),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pokemon_xp_adjustment_instance_created
  ON pokemon_xp_adjustment_claims(pokemon_instance_id, created_at DESC);
CREATE INDEX idx_pokemon_xp_adjustment_player_created
  ON pokemon_xp_adjustment_claims(player_id, created_at DESC);
CREATE INDEX idx_pokemon_xp_adjustment_correlation
  ON pokemon_xp_adjustment_claims(correlation_id, created_at DESC);
