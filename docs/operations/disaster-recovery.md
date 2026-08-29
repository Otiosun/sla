# Disaster recovery, forward migration and logical rollback

## Scope

This runbook is the canonical Phase 16 procedure for:

- **16.24** disaster recovery execution;
- **16.25** migration forward from the immediately previous application schema version;
- **16.26** logical rollback/restore without destructive automatic down migrations.

It complements `docs/operations/backup-restore.md`. Backup scheduling, retention and production alerting remain separate Phase 16 work and are not claimed here.

## Recovery model

The recovery model is **restore to a replacement database, validate, then cut over**. Do not rewrite a damaged production database in place and do not depend on destructive automatic down migrations.

If the newest valid backup was produced by an application version one migration behind the current release, restore that backup first and then run the normal forward migrator until `assertDatabaseSchemaCurrent` succeeds.

A recovery is complete only when the replacement database has passed schema-history and representative durable-state validation before application traffic is routed to it.

## Incident procedure

### 1. Declare and contain

1. Record incident start time, operator and correlation/incident identifier.
2. Stop or isolate writes when continued writes could increase corruption.
3. Preserve logs, the failed database and relevant artifacts. Do not destroy the original failure evidence.
4. Identify the last backup that has already passed restore validation when possible.

### 2. Select a recovery point

Record:

- backup artifact identifier and creation time;
- PostgreSQL version;
- source environment;
- source application/Git SHA when known;
- migration count and migration-history fingerprint when available.

The effective RPO is bounded by the age of the latest validated retained backup. No fixed production RPO or RTO SLA is claimed until automated backup scheduling/retention and the deployment environment are completed.

### 3. Restore into a replacement database

Create a new database or replacement database instance. Never restore over the damaged live database in place.

Use `pg_restore --exit-on-error` for the custom-format artifact. Any restore error fails the recovery attempt.

Example shape:

```bash
createdb "$RECOVERY_DATABASE"
pg_restore \
  --dbname "$RECOVERY_DATABASE_URL" \
  --exit-on-error \
  "$BACKUP_ARTIFACT"
```

### 4. Validate the restored state

Before any cutover, verify at minimum:

1. `schema_migrations` count;
2. ordered `(version, name, checksum)` history/fingerprint;
3. representative player state;
4. representative ledger/audit state for the affected domain;
5. active encounter/battle state when relevant;
6. Inbox/Outbox state when message delivery or replay is part of the incident;
7. content-release pointers when content activation is relevant.

If any invariant is wrong, do not cut over. Keep the failed replacement isolated, select another validated recovery point or investigate the restore failure.

### 5. Roll forward schema when required

If the restored database is behind the current code but its applied migration history matches an immutable prefix of the repository migrations:

```bash
MIGRATOR_DATABASE_URL="$RECOVERY_MIGRATOR_DATABASE_URL" pnpm db:migrate
DATABASE_URL="$RECOVERY_RUNTIME_DATABASE_URL" pnpm db:verify
```

The migrator only applies pending forward migrations. Applied migration names and checksums are immutable and verified before new migrations run.

Do not delete migration-history rows, edit already-applied migration files, or run an automatic destructive down-migration chain to make an old binary fit a newer database.

### 6. Cut over

Only after restore and migration validation succeed:

1. keep the old/damaged database isolated and preserved;
2. update the deployment database secret/config to the validated replacement database;
3. restart or roll the application through the normal deployment mechanism;
4. verify runtime schema readiness;
5. verify representative read and write paths;
6. monitor errors, conflicts and message backlog during the recovery window.

If replacement validation or post-cutover smoke checks fail, route traffic away from that replacement and return to containment. Do not mutate the original failure evidence merely to make the cutover pass.

## Logical rollback rule

For a bad application/data change, rollback is **state recovery**, not schema rewinding:

1. identify a known-good backup from before the bad change;
2. restore it into a new replacement database;
3. prove the restored durable probe equals the known-good state even when the source database has since diverged;
4. if needed, migrate the restored database forward to the current schema;
5. validate and cut over.

This deliberately avoids automatic down migrations. A down migration can destroy data that a later application version may have written and does not by itself restore known-good business state.

## Permanent CI evidence

The permanent `CI` workflow runs both recovery proofs against PostgreSQL 18.6:

### Previous-version forward migration proof

`db/proofs/phase16_recovery_migration_e2e.ts`:

- creates a database from the exact current migration set minus the latest migration;
- writes representative durable player state at N-1;
- verifies the latest schema effect is absent;
- runs the normal current migrator;
- verifies the exact latest migration name/checksum and current schema;
- verifies the representative durable state is unchanged;
- reruns migrations to prove convergence/idempotent no-op behavior.

The proof intentionally pins the expected current latest migration filename. When a new migration is added, CI fails until the previous-version boundary is consciously reviewed and updated.

### Logical rollback/restore proof

The existing custom-format backup proof is strengthened so CI:

- records known-good player state and migration fingerprint;
- creates the backup artifact;
- mutates the source player after the backup to simulate a bad post-backup state;
- restores the artifact into a new replacement database;
- proves the restored player returned to the known-good value rather than the mutated source value;
- proves migration count and migration-history fingerprint match the backup source point.

A successful dump alone is never treated as recovery evidence.

## Required incident evidence

Retain a recovery record containing:

- incident/correlation identifier;
- operator and timestamps;
- backup artifact identifier and creation time;
- PostgreSQL version;
- Git/application SHA used for validation;
- source and restored migration counts/fingerprints;
- representative state checks and their results;
- forward-migration result when used;
- replacement database identifier;
- cutover timestamp and smoke-check result;
- reason for any abandoned recovery attempt.

## Boundaries

This runbook does **not** claim:

- automated backup scheduling or retention (**16.22**);
- production backup/DB alerting (**16.21**);
- a secrets-manager deployment or secret-rotation mechanism (**16.18**);
- fixed production RPO/RTO guarantees.

Those require real deployment/infrastructure evidence and remain open until separately proven.
