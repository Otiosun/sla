-- 0067_competitive_spawn_rewards.sql
-- Reward decision is immutable history. Delivery is mutable operational retry state.

CREATE TABLE competitive_spawn_reward_intents (
  spawn_id UUID PRIMARY KEY REFERENCES competitive_spawns(id),
  player_id UUID NOT NULL REFERENCES players(id),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('MONEY', 'ITEM', 'PROGRESSION')),
  reward_amount BIGINT NOT NULL CHECK (reward_amount > 0),
  currency_id UUID NULL REFERENCES currency_definitions(id),
  item_id UUID NULL REFERENCES items(id),
  display_name TEXT NOT NULL CHECK (btrim(display_name) <> ''),
  correlation_id UUID NOT NULL,
  pokemon_bonus BOOLEAN NOT NULL,
  pokemon_bonus_basis_points INTEGER NOT NULL
    CHECK (pokemon_bonus_basis_points BETWEEN 0 AND 10000),
  pokemon_bonus_roll INTEGER NOT NULL CHECK (pokemon_bonus_roll BETWEEN 0 AND 9999),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (reward_kind = 'MONEY' AND currency_id IS NOT NULL AND item_id IS NULL)
    OR (reward_kind = 'ITEM' AND item_id IS NOT NULL AND currency_id IS NULL)
    OR (reward_kind = 'PROGRESSION' AND item_id IS NULL AND currency_id IS NULL)
  )
);

CREATE TABLE competitive_spawn_reward_deliveries (
  spawn_id UUID PRIMARY KEY REFERENCES competitive_spawn_reward_intents(spawn_id),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPLYING', 'APPLIED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at TIMESTAMPTZ NULL,
  applied_at TIMESTAMPTZ NULL,
  notification_projected_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_competitive_spawn_reward_deliveries_due
  ON competitive_spawn_reward_deliveries(status, next_attempt_at, created_at);

COMMENT ON TABLE competitive_spawn_reward_intents IS
  'Immutable winner reward decision, including Pokemon bonus roll. Never rewritten by runtime.';

COMMENT ON TABLE competitive_spawn_reward_deliveries IS
  'Mutable retry state for idempotent base reward application and winner message projection.';
