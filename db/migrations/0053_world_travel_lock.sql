ALTER TABLE player_travel_cooldowns
  ADD COLUMN reason TEXT NOT NULL DEFAULT 'POST_ARRIVAL'
    CHECK (reason IN ('POST_ARRIVAL', 'TRAVEL')),
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN destination_area_id UUID REFERENCES areas(id);

COMMENT ON TABLE player_travel_cooldowns IS
  'Durable travel availability. POST_ARRIVAL blocks only another travel; TRAVEL represents a short player-facing displacement lock.';
COMMENT ON COLUMN player_travel_cooldowns.reason IS
  'POST_ARRIVAL preserves arrival cooldown semantics; TRAVEL blocks encounter spawn and travel until available_at.';
COMMENT ON COLUMN player_travel_cooldowns.destination_area_id IS
  'Internal destination reference for an active short travel lock; never exposed as a slug/UUID to players.';
