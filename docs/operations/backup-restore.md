# Backup and restore verification

## Scope

This runbook documents the Phase 16 restore validity rule. A backup is **not** considered valid merely because `pg_dump` completed. It is valid only after the artifact restores into a disposable PostgreSQL database with `pg_restore --exit-on-error` and the restored state passes integrity checks.

This document satisfies the restore-test documentation requirement. Automated backup scheduling and retention remain separate Phase 16 work and are not claimed here.

## Permanent CI proof

`.github/workflows/ci.yml` runs `Logical backup and disposable restore proof` against the pinned PostgreSQL 18.6 container on every applicable CI run.

The proof performs all of the following:

1. inserts a deterministic data probe into `players`;
2. records the migration count and a fingerprint of `(version, name, checksum)` from `schema_migrations`;
3. creates a full custom-format dump with `pg_dump`;
4. creates a new disposable database;
5. restores the dump with `pg_restore --exit-on-error`;
6. verifies the restored migration count;
7. verifies the restored migration-history fingerprint;
8. verifies the data probe exists with the same state.

A failure in any step fails CI.

## Operator procedure

Use credentials supplied by the deployment secret/environment layer. Never paste production credentials into Git, issues, logs, chat transcripts, or Drive documents.

Example shape:

```bash
set -euo pipefail

pg_dump \
  --dbname "$SOURCE_DATABASE_URL" \
  --format custom \
  --file backup.dump

createdb "$DISPOSABLE_RESTORE_DATABASE"

pg_restore \
  --dbname "$DISPOSABLE_RESTORE_DATABASE_URL" \
  --exit-on-error \
  backup.dump
```

After restore, verify at minimum:

```sql
SELECT count(*) FROM schema_migrations;
SELECT version, name, checksum FROM schema_migrations ORDER BY version;
```

For an operational restore rehearsal, also verify representative durable state such as players, ledger history, content release pointers, active encounter/battle records, Inbox/Outbox rows, and admin audit evidence according to the incident scope.

## Safety rules

- Restore rehearsals target a new/disposable database, never the live production database in place.
- Do not rely on destructive automatic down migrations for recovery.
- Preserve the original backup artifact until the restored database has passed validation.
- Treat `pg_restore` warnings/errors as failures unless explicitly reviewed and documented.
- Validate schema/migration history before routing application traffic to a restored database.
- Keep backup credentials and encryption material outside the repository.
- Automated backup retention, alerting, and full disaster-recovery orchestration are tracked separately by Phase 16 items 16.21, 16.22 and 16.24.

## Definition of valid restore evidence

A restore evidence record must identify the source environment/artifact, timestamp, PostgreSQL version, result of `pg_restore --exit-on-error`, migration-history comparison, representative state checks, and the Git SHA/run that executed the proof when applicable.
