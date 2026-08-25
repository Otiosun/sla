\set ON_ERROR_STOP on

-- Operational bootstrap, intentionally separate from numbered schema migrations.
-- Run as the database owner/provider admin BEFORE migrations.
-- Required psql variables: migrator_role, migrator_password, runtime_role, runtime_password.
-- Secrets are supplied through psql variables/environment and are never committed.

SELECT format('CREATE ROLE %I LOGIN', :'migrator_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_role')
\gexec

SELECT format('CREATE ROLE %I LOGIN', :'runtime_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
\gexec

-- Re-running the bootstrap is also the supported password-rotation path.
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'migrator_role', :'migrator_password'
) \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_role', :'runtime_password'
) \gexec

-- The application database is dedicated to this service. PUBLIC never gets schema creation rights.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migrator_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec

-- Migrator creates/owns application objects. Runtime can only resolve names until the
-- post-migration runtime_grants.sql reconciliation is applied by the migrator itself.
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migrator_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'runtime_role') \gexec
