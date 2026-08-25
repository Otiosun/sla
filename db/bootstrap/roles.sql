\set ON_ERROR_STOP on

-- Operational bootstrap, intentionally separate from schema migration 0001.
-- Required psql variables: migrator_role, migrator_password, runtime_role, runtime_password.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'migrator_role', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_role')
\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'runtime_role', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migrator_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migrator_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE schema_migrations TO %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec
SELECT format('REVOKE UPDATE, DELETE ON TABLE %I FROM %I', protected_table, :'runtime_role')
FROM (VALUES
  ('audit_events'), ('inventory_ledger'), ('wallet_ledger'), ('trainer_progress_ledger'),
  ('pokemon_history_events'), ('battle_events'), ('admin_operation_changes')
) AS protected(protected_table)
WHERE to_regclass('public.' || protected_table) IS NOT NULL
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'migrator_role', :'runtime_role'
) \gexec
