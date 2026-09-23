-- Minimal durable social-party scope for narrator-created PVE spawns.
CREATE TABLE player_parties (
  id UUID PRIMARY KEY,
  leader_player_id UUID NOT NULL REFERENCES players(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE player_party_members (
  party_id UUID NOT NULL REFERENCES player_parties(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, player_id)
);

CREATE UNIQUE INDEX uq_player_party_members_active_player
  ON player_party_members(player_id) WHERE active;
CREATE INDEX idx_player_parties_active_leader ON player_parties(active, leader_player_id);
