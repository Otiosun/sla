\set ON_ERROR_STOP on

-- Post-migration privilege reconciliation.
-- Run as the configured migrator role AFTER all numbered migrations and BEFORE runtime starts.
-- Required psql variables: migrator_role, runtime_role.

-- Refuse to grant against objects that were not created/owned by the configured migrator.
-- This catches accidental migrations run with provider-owner/superuser credentials.
SELECT format(
  $sql$
  DO $block$
  BEGIN
    IF current_user <> %L THEN
      RAISE EXCEPTION 'runtime_grants.sql must be executed as the configured migrator role';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND pg_get_userbyid(c.relowner) <> %L
    ) THEN
      RAISE EXCEPTION 'public application objects are not all owned by the configured migrator role';
    END IF;
  END
  $block$;
  $sql$,
  :'migrator_role', :'migrator_role'
) \gexec

-- Start from zero effective table privileges on each reconciliation. Ordinary application
-- state gets SELECT/INSERT/UPDATE. Physical DELETE is denied by default and must be explicitly
-- allowlisted only where removing a transient relationship/state row is part of domain semantics.
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', :'runtime_role') \gexec

SELECT format(
  'GRANT DELETE ON TABLE %I TO %I',
  deletable_table,
  :'runtime_role'
)
FROM (VALUES
  ('admin_role_capabilities'),
  ('admin_principal_roles'),
  ('pokemon_move_slots'),
  ('pokemon_roster_slots'),
  ('pokemon_persistent_conditions'),
  ('active_effects')
) AS deletable(deletable_table)
WHERE to_regclass('public.' || deletable_table) IS NOT NULL
\gexec

-- Migration history is runtime-readable for startup verification, never runtime-writable.
SELECT format('REVOKE ALL PRIVILEGES ON TABLE schema_migrations FROM %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE schema_migrations TO %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec

-- Append-only/immutable runtime records. INSERT is allowed where the application must append;
-- UPDATE/DELETE/TRUNCATE are denied. Corrections happen through compensating records or
-- explicit future maintenance/admin capabilities, never by rewriting history.
SELECT format(
  'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %I FROM %I',
  protected_table,
  :'runtime_role'
)
FROM (VALUES
  ('trainer_progress_ledger'),
  ('pokemon_history_events'),
  ('starter_grants'),
  ('inventory_ledger'),
  ('wallet_ledger'),
  ('encounter_snapshots'),
  ('battle_state_snapshots'),
  ('battle_events'),
  ('audit_events'),
  ('admin_operation_changes')
) AS protected(protected_table)
WHERE to_regclass('public.' || protected_table) IS NOT NULL
\gexec
