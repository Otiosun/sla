# PostgreSQL role bootstrap

`0001_core_schema.sql` never creates environment-specific login roles. Staging/production use separate credentials:

- **migrator** — owns/applies numbered migrations;
- **runtime** — application DML, no migration writes and no mutation of append-only audit/ledger/event tables;
- **readonly/support** — deferred until the support/admin surface needs it.

Run `roles.sql` as the database owner/provider admin and pass secrets through `psql` variables, never Git. Run once to create roles/schema permissions, apply migrations as migrator, then run it again to apply runtime grants to current tables.

```bash
psql "$DATABASE_OWNER_URL" \
  --set=migrator_role=pokemon_migrator \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=runtime_role=pokemon_runtime \
  --set=runtime_password="$RUNTIME_PASSWORD" \
  --file=db/bootstrap/roles.sql
```

Provider-specific role creation/grants remain operational infrastructure and are not embedded in migration `0001`.
