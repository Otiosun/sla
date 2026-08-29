-- 0024_initial_admin_bootstrap_state.sql
-- Phase 17.6: durable one-shot marker for the first administrative principal bootstrap.

CREATE TABLE admin_initial_bootstrap_state (
  singleton_key TEXT PRIMARY KEY
    CHECK (singleton_key = 'INITIAL_ADMIN'),
  principal_id UUID NOT NULL UNIQUE REFERENCES admin_principals(id),
  role_id UUID NOT NULL REFERENCES admin_roles(id),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  deployment_revision TEXT NOT NULL
    CHECK (deployment_revision ~ '^[0-9a-f]{40}$'),
  correlation_id UUID NOT NULL UNIQUE,
  bootstrapped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_initial_bootstrap_state IS
  'Immutable marker for the one-time initial admin bootstrap. Ordinary runtime may read but must never insert, update, delete or truncate this table.';
