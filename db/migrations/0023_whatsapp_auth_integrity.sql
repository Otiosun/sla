-- 0023_whatsapp_auth_integrity.sql
-- Phase 17 runtime foundation: durable encrypted WhatsApp auth state.
-- Auth material is encrypted by the application; plaintext credentials never belong in PostgreSQL.

CREATE TABLE whatsapp_auth_sessions (
  session_key TEXT PRIMARY KEY
    CHECK (session_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  credentials_ciphertext BYTEA NOT NULL,
  credentials_iv BYTEA NOT NULL CHECK (octet_length(credentials_iv) = 12),
  credentials_auth_tag BYTEA NOT NULL CHECK (octet_length(credentials_auth_tag) = 16),
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version > 0),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE whatsapp_auth_keys (
  session_key TEXT NOT NULL REFERENCES whatsapp_auth_sessions(session_key),
  key_type TEXT NOT NULL CHECK (length(key_type) BETWEEN 1 AND 128),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 512),
  value_ciphertext BYTEA NULL,
  value_iv BYTEA NULL,
  value_auth_tag BYTEA NULL,
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version > 0),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_key, key_type, key_id),
  CHECK (
    (deleted = TRUE AND value_ciphertext IS NULL AND value_iv IS NULL AND value_auth_tag IS NULL)
    OR
    (
      deleted = FALSE
      AND value_ciphertext IS NOT NULL
      AND value_iv IS NOT NULL AND octet_length(value_iv) = 12
      AND value_auth_tag IS NOT NULL AND octet_length(value_auth_tag) = 16
    )
  )
);

CREATE INDEX idx_whatsapp_auth_keys_session_active
  ON whatsapp_auth_keys(session_key, key_type, key_id)
  WHERE deleted = FALSE;

COMMENT ON TABLE whatsapp_auth_sessions IS
  'Encrypted Baileys credential state. A session-level PostgreSQL advisory lock prevents two live runtimes from owning the same WhatsApp session.';
COMMENT ON TABLE whatsapp_auth_keys IS
  'Encrypted Baileys signal-key state. Deletion is represented as an UPDATE tombstone so runtime does not require broad DELETE privileges.';
