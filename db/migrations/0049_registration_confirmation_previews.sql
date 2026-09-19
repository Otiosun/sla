-- Durable confirmation evidence bridges independent inbound WhatsApp messages.
CREATE TABLE registration_confirmation_previews (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
