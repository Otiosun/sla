# PostgreSQL role bootstrap

`0001_core_schema.sql` never creates environment-specific login roles. Staging/production use separate credentials:

- **migrator** — applies and owns numbered migrations;
- **runtime** — application DML, no DDL, no migration writes and no destructive deletion of durable/history records;
- **readonly/support** — deferred until the support/admin surface needs it.

## Required deployment order

The order is part of the integrity contract. Keep runtime stopped while schema changes are being deployed.

1. Run `roles.sql` as the database owner/provider admin. It creates or rotates the two login roles, removes public schema-creation rights and grants the migrator `USAGE, CREATE` on `public`. It intentionally grants the runtime **no table access**.
2. Apply numbered migrations using `MIGRATOR_DATABASE_URL`. Every application object must therefore be owned by the migrator role.
3. Run `runtime_grants.sql` **as the migrator role**. It fails if public application objects have the wrong owner, then reconciles runtime privileges.
4. Run `db:verify` using the runtime credential.
5. Only after those checks pass may the runtime process start.

This is deliberately fail-closed: a newly created table is unavailable to runtime until the post-migration grant reconciliation runs.

## Pre-migration role bootstrap

```bash
psql "$DATABASE_OWNER_URL" \
  --set=migrator_role=pokemon_migrator \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=runtime_role=pokemon_runtime \
  --set=runtime_password="$RUNTIME_PASSWORD" \
  --file=db/bootstrap/roles.sql
```

Re-running `roles.sql` is the supported password-rotation path. Passwords are never stored in Git or Drive.

## Migration

```bash
MIGRATOR_DATABASE_URL="$MIGRATOR_DATABASE_URL" \
DATABASE_URL="$RUNTIME_DATABASE_URL" \
pnpm db:migrate
```

## Post-migration runtime grants

```bash
psql "$MIGRATOR_DATABASE_URL" \
  --set=migrator_role=pokemon_migrator \
  --set=runtime_role=pokemon_runtime \
  --file=db/bootstrap/runtime_grants.sql
```

Runtime gets `SELECT`, `INSERT` and `UPDATE` on ordinary application tables. `DELETE` is denied by default and is granted only to a small explicit allowlist of transient relationship/state tables whose normal domain operation requires row removal: admin role assignments, Pokémon move/roster slots, persistent conditions and active effects.

Durable entities, economy/progression data and historical records remain non-deletable by runtime. Append-only ledgers, audit/history records and immutable snapshots additionally lose `UPDATE` and `TRUNCATE`. `schema_migrations` is `SELECT`-only.

Provider-specific role creation/grants remain operational infrastructure and are not embedded in numbered schema migrations.
