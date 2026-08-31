-- 0030_admin_session_revocation_cutoff.sql
-- Principal-level cutoff for governed administrative session revocation.
-- Access assertions issued at or before this instant cannot create or refresh a durable session.

ALTER TABLE admin_principals
  ADD COLUMN admin_access_sessions_revoked_before TIMESTAMPTZ NULL;

ALTER TABLE admin_principals
  ADD CONSTRAINT admin_principals_session_revocation_cutoff_check
  CHECK (
    admin_access_sessions_revoked_before IS NULL
    OR admin_access_sessions_revoked_before >= created_at
  );

COMMENT ON COLUMN admin_principals.admin_access_sessions_revoked_before IS
  'Security cutoff set by governed admin.session.revoke_all. Verified Access assertions must have access_issued_at strictly after this instant before durable session admission; this prevents previously unseen pre-revocation tokens from recreating local admin sessions.';
