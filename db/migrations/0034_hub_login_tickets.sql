CREATE TABLE hub_login_tickets (
  id UUID PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE CHECK (length(ticket_hash) = 64),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) BETWEEN 1 AND 32),
  external_id TEXT NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 255),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hub_login_tickets_expires_at
  ON hub_login_tickets(expires_at);
