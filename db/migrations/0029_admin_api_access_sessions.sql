-- 0029_admin_api_access_sessions.sql
-- Durable server-side session state for cryptographically verified Cloudflare Access assertions.
-- Raw Access JWTs are never persisted: only their SHA-256 fingerprint is stored.

CREATE TABLE admin_access_sessions (
  token_fingerprint TEXT PRIMARY KEY
    CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  environment TEXT NOT NULL
    CHECK (environment IN ('development', 'staging', 'production')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED')),
  access_issued_at TIMESTAMPTZ NOT NULL,
  access_not_before TIMESTAMPTZ NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_principal_id UUID REFERENCES admin_principals(id),
  revocation_reason TEXT,
  CHECK (access_issued_at <= access_expires_at),
  CHECK (access_not_before <= access_expires_at),
  CHECK (created_at <= last_seen_at),
  CHECK (last_seen_at < idle_expires_at),
  CHECK (idle_expires_at <= access_expires_at),
  CHECK (
    (status = 'ACTIVE'
      AND revoked_at IS NULL
      AND revoked_by_principal_id IS NULL
      AND revocation_reason IS NULL)
    OR
    (status = 'REVOKED'
      AND revoked_at IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND length(revocation_reason) BETWEEN 1 AND 256)
  )
);

CREATE INDEX idx_admin_access_sessions_principal_status
  ON admin_access_sessions(principal_id, environment, status);

CREATE INDEX idx_admin_access_sessions_idle_expiry
  ON admin_access_sessions(idle_expires_at)
  WHERE status = 'ACTIVE';

COMMENT ON TABLE admin_access_sessions IS
  'Durable Control Center session state keyed only by SHA-256 fingerprint of a verified Access JWT. REVOKED rows are tombstones so a still-signed token cannot recreate its local administrative session.';

COMMENT ON COLUMN admin_access_sessions.token_fingerprint IS
  'Lowercase SHA-256 hex fingerprint of the verified Cloudflare Access JWT. The raw JWT is never stored.';
