\set ON_ERROR_STOP on

-- Operational bootstrap for the internet-facing public verification service.
-- Run as the database owner/provider admin BEFORE migrations.
-- Required psql variables: public_verification_role, public_verification_password.
-- Secrets are supplied through psql variables/environment and are never committed.

SELECT format('CREATE ROLE %I LOGIN', :'public_verification_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'public_verification_role')
\gexec

-- Re-running this bootstrap is the supported password-rotation path.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'public_verification_role', :'public_verification_password'
) \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'public_verification_role') \gexec
GRANT USAGE ON SCHEMA public TO :"public_verification_role";
REVOKE CREATE ON SCHEMA public FROM :"public_verification_role";
