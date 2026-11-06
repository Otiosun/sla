-- INERT CANDIDATE. Apply ONLY in a new disposable test database.
-- No active migration, backfill, rewards, content odds or live runtime activation.
CREATE TABLE combat_scene_gates (
  scope TEXT PRIMARY KEY CHECK (scope ~ '^[a-f0-9]{64}$'),
  provider TEXT NOT NULL,
  sender_ref TEXT NOT NULL,
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE combat_scene_receipts (
  provider TEXT NOT NULL,
  sender_ref TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  scope TEXT NOT NULL REFERENCES combat_scene_gates(scope),
  result JSONB NULL CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,sender_ref,external_message_id)
);
