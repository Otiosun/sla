-- 0015_pokemon_admin_create_progress_integrity.sql
-- Phase 12C: durable evidence for invariant-preserving Pokemon admin creation and progression correction.
-- Migrations 0001-0014 are immutable.

CREATE TABLE pokemon_admin_create_claims (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  pokemon_instance_id UUID NOT NULL UNIQUE REFERENCES pokemon_instances(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pokemon_admin_create_player_created
  ON pokemon_admin_create_claims(player_id, created_at DESC);
CREATE INDEX idx_pokemon_admin_create_correlation
  ON pokemon_admin_create_claims(correlation_id);

CREATE TRIGGER trg_pokemon_admin_create_claim_immutable
BEFORE UPDATE OR DELETE ON pokemon_admin_create_claims
FOR EACH ROW EXECUTE FUNCTION guard_pokemon_admin_operation_claim_immutable();

CREATE TABLE pokemon_admin_progress_corrections (
  id UUID PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  player_id UUID NOT NULL REFERENCES players(id),
  before_level SMALLINT NOT NULL CHECK (before_level BETWEEN 1 AND 100),
  before_xp BIGINT NOT NULL CHECK (before_xp >= 0),
  after_level SMALLINT NOT NULL CHECK (after_level BETWEEN 1 AND 100),
  after_xp BIGINT NOT NULL CHECK (after_xp >= 0),
  before_hp INTEGER NOT NULL CHECK (before_hp >= 0),
  after_hp INTEGER NOT NULL CHECK (after_hp >= 0),
  old_max_hp INTEGER NOT NULL CHECK (old_max_hp > 0),
  new_max_hp INTEGER NOT NULL CHECK (new_max_hp > 0),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id UUID NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'ADMIN' AND actor_id IS NOT NULL) OR actor_type <> 'ADMIN')
);

CREATE INDEX idx_pokemon_admin_progress_instance_created
  ON pokemon_admin_progress_corrections(pokemon_instance_id, created_at DESC);
CREATE INDEX idx_pokemon_admin_progress_player_created
  ON pokemon_admin_progress_corrections(player_id, created_at DESC);
CREATE INDEX idx_pokemon_admin_progress_correlation
  ON pokemon_admin_progress_corrections(correlation_id);

CREATE TRIGGER trg_pokemon_admin_progress_correction_immutable
BEFORE UPDATE OR DELETE ON pokemon_admin_progress_corrections
FOR EACH ROW EXECUTE FUNCTION guard_pokemon_admin_operation_claim_immutable();
