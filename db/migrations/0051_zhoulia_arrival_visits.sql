-- Durable first-arrival evidence and post-arrival travel cooldowns for world presentation.
CREATE TABLE player_area_visits (
  player_id UUID NOT NULL REFERENCES players(id),
  area_id UUID NOT NULL REFERENCES areas(id),
  first_visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  visit_count BIGINT NOT NULL DEFAULT 1 CHECK (visit_count > 0),
  PRIMARY KEY (player_id, area_id)
);

INSERT INTO player_area_visits(player_id, area_id, first_visited_at, last_visited_at)
SELECT player_id, area_id, entered_at, entered_at
FROM player_locations
ON CONFLICT (player_id, area_id) DO NOTHING;

CREATE TABLE player_travel_cooldowns (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  available_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE world_travel_receipts
  ADD COLUMN arrival_first_visit BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON TABLE player_area_visits IS 'Minimal durable visit evidence used for world arrival presentation.';
COMMENT ON TABLE player_travel_cooldowns IS 'Post-arrival travel availability; no asynchronous travel is modeled.';
