\set ON_ERROR_STOP on

-- Post-migration least-privilege reconciliation for the internet-facing verifier.
-- Run as the configured migrator role AFTER all numbered migrations.
-- Required psql variables: migrator_role, public_verification_role.

SELECT format(
  $sql$
  DO $block$
  BEGIN
    IF current_user <> %L THEN
      RAISE EXCEPTION 'public_verification_grants.sql must be executed as the configured migrator role';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %L) THEN
      RAISE EXCEPTION 'configured public verification role does not exist';
    END IF;
  END
  $block$;
  $sql$,
  :'migrator_role', :'public_verification_role'
) \gexec

-- Reset table authority to zero before applying the tiny allowlist.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"public_verification_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"public_verification_role";

-- Startup schema verification is read-only.
GRANT SELECT ON TABLE public.schema_migrations TO :"public_verification_role";

-- Public card verification reads immutable verification records but cannot issue/revoke/rewrite them.
GRANT SELECT ON TABLE public.trainer_card_verifications TO :"public_verification_role";

-- Durable abuse protection is the only writable state owned by this process.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_verification_rate_limit_buckets TO :"public_verification_role";

-- Self-verification: the role must have the exact positive allowlist and nothing else.
SELECT
  has_table_privilege(:'public_verification_role', 'public.schema_migrations', 'SELECT')
  AND NOT has_table_privilege(:'public_verification_role', 'public.schema_migrations', 'INSERT')
  AND NOT has_table_privilege(:'public_verification_role', 'public.schema_migrations', 'UPDATE')
  AND NOT has_table_privilege(:'public_verification_role', 'public.schema_migrations', 'DELETE')
  AND has_table_privilege(:'public_verification_role', 'public.trainer_card_verifications', 'SELECT')
  AND NOT has_table_privilege(:'public_verification_role', 'public.trainer_card_verifications', 'INSERT')
  AND NOT has_table_privilege(:'public_verification_role', 'public.trainer_card_verifications', 'UPDATE')
  AND NOT has_table_privilege(:'public_verification_role', 'public.trainer_card_verifications', 'DELETE')
  AND has_table_privilege(:'public_verification_role', 'public.public_verification_rate_limit_buckets', 'SELECT')
  AND has_table_privilege(:'public_verification_role', 'public.public_verification_rate_limit_buckets', 'INSERT')
  AND has_table_privilege(:'public_verification_role', 'public.public_verification_rate_limit_buckets', 'UPDATE')
  AND has_table_privilege(:'public_verification_role', 'public.public_verification_rate_limit_buckets', 'DELETE')
AS public_verification_allowlist_ok
\gset

\if :public_verification_allowlist_ok
\else
  \echo 'public verification positive privilege allowlist is incomplete or too broad'
  \quit 1
\endif

SELECT NOT EXISTS (
  SELECT 1
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname NOT IN (
      'schema_migrations',
      'trainer_card_verifications',
      'public_verification_rate_limit_buckets'
    )
    AND (
      has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'SELECT')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'INSERT')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'UPDATE')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'DELETE')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'TRUNCATE')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'REFERENCES')
      OR has_table_privilege(:'public_verification_role', format('%I.%I', n.nspname, c.relname), 'TRIGGER')
    )
) AS public_verification_no_domain_privileges
\gset

\if :public_verification_no_domain_privileges
\else
  \echo 'public verification role escaped its table allowlist'
  \quit 1
\endif

SELECT
  has_schema_privilege(:'public_verification_role', 'public', 'USAGE')
  AND NOT has_schema_privilege(:'public_verification_role', 'public', 'CREATE')
AS public_verification_schema_ok
\gset

\if :public_verification_schema_ok
\else
  \echo 'public verification schema privileges are invalid'
  \quit 1
\endif
