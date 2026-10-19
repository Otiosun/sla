-- Premium support is an append-only administrative ledger.
-- A support RESOLVED event is NOT a payment confirmation or a benefit grant.
CREATE TABLE premium_support_events (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  order_id UUID NULL REFERENCES premium_orders(id),
  actor_principal_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTE', 'REVIEW', 'RESOLVED')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 8 AND 1400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_premium_support_events_player_created
  ON premium_support_events(player_id, created_at DESC, id DESC);

COMMENT ON TABLE premium_support_events IS
  'Owner-only support history. Immutable notes, reviews and resolutions; not a payment or entitlement authority.';
