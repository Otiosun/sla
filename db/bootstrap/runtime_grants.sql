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
  ('active_effects'),
  -- Encounter entries are revision-local DRAFT details. The database trigger still rejects
  -- DELETE whenever the owning content release is not DRAFT.
  ('encounter_entries')
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
  ('pokemon_xp_ledger'),
  ('pokemon_evolution_claims'),
  ('battle_reward_claims'),
  ('pokemon_admin_operation_claims'),
  ('encounter_admin_operation_claims'),
  ('catalog_admin_operation_claims'),
  ('catalog_release_admin_operation_claims'),
  ('admin_batch_targets'),
  ('admin_operation_compensations'),
  ('starter_grants'),
  ('player_onboarding_context'),
  ('inventory_ledger'),
  ('wallet_ledger'),
  ('encounter_snapshots'),
  ('battle_state_snapshots'),
  ('battle_events'),
  ('audit_events'),
  ('admin_operation_changes'),
  ('admin_operation_confirmations'),
  ('admin_operation_approvals'),
  ('messaging_rate_limit_charges')
) AS protected(protected_table)
WHERE to_regclass('public.' || protected_table) IS NOT NULL
\gexec

-- Reconciliation is self-verifying. Any accidental privilege broadening blocks deployment.
SELECT format(
  $sql$
  DO $block$
  DECLARE
    runtime_name TEXT := %L;
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname <> ALL (ARRAY[
          'admin_role_capabilities',
          'admin_principal_roles',
          'pokemon_move_slots',
          'pokemon_roster_slots',
          'pokemon_persistent_conditions',
          'active_effects',
          'encounter_entries'
        ])
        AND has_table_privilege(runtime_name, format('%%I.%%I', n.nspname, c.relname), 'DELETE')
    ) THEN
      RAISE EXCEPTION 'runtime DELETE privilege escaped the explicit allowlist';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'admin_role_capabilities',
        'admin_principal_roles',
        'pokemon_move_slots',
        'pokemon_roster_slots',
        'pokemon_persistent_conditions',
        'active_effects',
        'encounter_entries'
      ]) AS allowed(table_name)
      WHERE to_regclass('public.' || table_name) IS NOT NULL
        AND NOT has_table_privilege(runtime_name, 'public.' || table_name, 'DELETE')
    ) THEN
      RAISE EXCEPTION 'runtime DELETE allowlist is incomplete';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'trainer_progress_ledger',
        'pokemon_history_events',
        'pokemon_xp_ledger',
        'pokemon_evolution_claims',
        'battle_reward_claims',
        'pokemon_admin_operation_claims',
        'encounter_admin_operation_claims',
        'catalog_admin_operation_claims',
        'catalog_release_admin_operation_claims',
        'admin_batch_targets',
        'admin_operation_compensations',
        'starter_grants',
        'player_onboarding_context',
        'inventory_ledger',
        'wallet_ledger',
        'encounter_snapshots',
        'battle_state_snapshots',
        'battle_events',
        'audit_events',
        'admin_operation_changes',
        'admin_operation_confirmations',
        'admin_operation_approvals',
        'messaging_rate_limit_charges'
      ]) AS protected(table_name)
      WHERE to_regclass('public.' || table_name) IS NOT NULL
        AND (
          has_table_privilege(runtime_name, 'public.' || table_name, 'UPDATE')
          OR has_table_privilege(runtime_name, 'public.' || table_name, 'DELETE')
          OR has_table_privilege(runtime_name, 'public.' || table_name, 'TRUNCATE')
        )
    ) THEN
      RAISE EXCEPTION 'append-only runtime privilege policy was not enforced';
    END IF;

    IF to_regclass('public.schema_migrations') IS NOT NULL AND (
      NOT has_table_privilege(runtime_name, 'public.schema_migrations', 'SELECT')
      OR has_table_privilege(runtime_name, 'public.schema_migrations', 'INSERT')
      OR has_table_privilege(runtime_name, 'public.schema_migrations', 'UPDATE')
      OR has_table_privilege(runtime_name, 'public.schema_migrations', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'schema_migrations must be SELECT-only for runtime';
    END IF;
  END
  $block$;
  $sql$,
  :'runtime_role'
) \gexec