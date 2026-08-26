-- 0009_progression_integrity.sql
-- Phase 11: durable Pokemon XP audit, exactly-once battle rewards,
-- safe pending move choices and idempotent evolution claims.
-- Migrations 0001-0008 are immutable.

CREATE TABLE pokemon_xp_ledger (
  id UUID PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  awarded_xp BIGINT NOT NULL CHECK (awarded_xp > 0),
  before_level SMALLINT NOT NULL CHECK (before_level >= 1),
  after_level SMALLINT NOT NULL CHECK (after_level >= before_level),
  before_xp BIGINT NOT NULL CHECK (before_xp >= 0),
  after_xp BIGINT NOT NULL CHECK (after_xp >= 0),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id UUID NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_scope, idempotency_key)
);

CREATE INDEX idx_pokemon_xp_ledger_instance_created
  ON pokemon_xp_ledger(pokemon_instance_id, created_at DESC);
CREATE INDEX idx_pokemon_xp_ledger_source
  ON pokemon_xp_ledger(source_type, source_id);
CREATE INDEX idx_pokemon_xp_ledger_correlation
  ON pokemon_xp_ledger(correlation_id, created_at DESC);

CREATE TABLE battle_reward_claims (
  battle_id UUID PRIMARY KEY REFERENCES battles(id),
  player_id UUID NOT NULL REFERENCES players(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  correlation_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_battle_reward_claims_player_applied
  ON battle_reward_claims(player_id, applied_at DESC);
CREATE INDEX idx_battle_reward_claims_correlation
  ON battle_reward_claims(correlation_id);

CREATE TABLE pending_move_choices (
  id UUID PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  move_id UUID NOT NULL REFERENCES moves(id),
  learn_level SMALLINT NOT NULL CHECK (learn_level >= 1),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'SKIPPED')),
  replaced_slot_no SMALLINT NULL CHECK (replaced_slot_no IS NULL OR replaced_slot_no BETWEEN 1 AND 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (pokemon_instance_id, content_release_id, move_id, learn_level),
  CHECK (
    (status = 'PENDING' AND replaced_slot_no IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND replaced_slot_no IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'SKIPPED' AND replaced_slot_no IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX idx_pending_move_choices_instance_status
  ON pending_move_choices(pokemon_instance_id, status, created_at);

CREATE TABLE pokemon_evolution_claims (
  id UUID PRIMARY KEY,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id),
  content_release_id UUID NOT NULL REFERENCES content_releases(id),
  ruleset_id UUID NOT NULL REFERENCES rulesets(id),
  from_form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  to_form_id UUID NOT NULL REFERENCES pokemon_forms(id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('LEVEL', 'ITEM', 'CONDITION')),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  evolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_scope, idempotency_key),
  CHECK (from_form_id <> to_form_id)
);

CREATE INDEX idx_pokemon_evolution_claims_instance_evolved
  ON pokemon_evolution_claims(pokemon_instance_id, evolved_at DESC);
CREATE INDEX idx_pokemon_evolution_claims_correlation
  ON pokemon_evolution_claims(correlation_id, evolved_at DESC);
