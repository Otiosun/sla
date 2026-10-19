-- Staging-first, human-operated premium delivery cases.
-- NOT a payment processor and NOT evidence of an automatic in-game benefit.
CREATE TABLE premium_delivery_cases (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  sku TEXT NOT NULL CHECK (sku ~ '^[A-Z0-9][A-Z0-9_.:-]{1,127}$'),
  quantity SMALLINT NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'CANCELLED')),
  opening_actor_id UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_premium_delivery_cases_player_created
  ON premium_delivery_cases(player_id, created_at DESC, id DESC);
CREATE INDEX idx_premium_delivery_cases_state_updated
  ON premium_delivery_cases(state, updated_at DESC, id DESC);

CREATE TABLE premium_delivery_case_events (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES premium_delivery_cases(id),
  actor_principal_id UUID NOT NULL,
  next_state TEXT NOT NULL CHECK (next_state IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'CANCELLED')),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 8 AND 1400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_premium_delivery_case_events_case_created
  ON premium_delivery_case_events(case_id, created_at, id);

COMMENT ON TABLE premium_delivery_cases IS
  'Human-operated premium support/delivery cases only; CLOSED means owner attestation, not auto-fulfillment or payment.';
COMMENT ON TABLE premium_delivery_case_events IS
  'Append-only owner events, idempotent by event UUID. Never authorizes a benefit or payment.';
