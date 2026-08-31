-- 0030_admin_session_revocation_cutoff.sql
-- Environment-scoped cutoff for governed administrative session revocation.
-- Access assertions issued at or before the cutoff cannot create or refresh a durable
-- session in that same environment. Staging and production revocation state must not bleed.

CREATE TABLE admin_access_session_revocation_cutoffs (
  principal_id UUID NOT NULL REFERENCES admin_principals(id),
  environment TEXT NOT NULL
    CHECK (environment IN ('development', 'staging', 'production')),
  revoked_before TIMESTAMPTZ NOT NULL,
  revoked_by_principal_id UUID NOT NULL REFERENCES admin_principals(id),
  revocation_reason TEXT NOT NULL
    CHECK (length(revocation_reason) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, environment),
  CHECK (updated_at >= created_at)
);

COMMENT ON TABLE admin_access_session_revocation_cutoffs IS
  'Latest governed revoke-all cutoff per admin principal and deployment environment. This prevents previously unseen pre-revocation Access assertions from recreating local admin sessions without coupling staging and production session state.';
