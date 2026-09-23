-- 0036_pokemon_center_healing_claims.sql
-- Durable replay evidence for atomic Pokemon Center team recovery.

CREATE TABLE pokemon_center_healing_claims (
  source_inbox_message_id UUID PRIMARY KEY REFERENCES inbox_messages(id),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES world_service_sessions(id),
  healed_pokemon_count INTEGER NOT NULL CHECK (healed_pokemon_count >= 0),
  hp_restored_pokemon_count INTEGER NOT NULL CHECK (hp_restored_pokemon_count >= 0),
  pp_restored_slots INTEGER NOT NULL CHECK (pp_restored_slots >= 0),
  statuses_cleared INTEGER NOT NULL CHECK (statuses_cleared >= 0),
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pokemon_center_healing_claims_player_created
  ON pokemon_center_healing_claims(player_id, created_at DESC);

COMMENT ON TABLE pokemon_center_healing_claims IS
  'One committed Pokemon Center healing result per inbound command, used for durable replay without applying recovery twice.';
