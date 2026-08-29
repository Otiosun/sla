# Backup and restore verification

## Scope

A backup is **not** considered valid merely because `pg_dump` completed. It is valid only after the artifact is structurally readable and restore evidence proves that durable state can be reconstructed. Permanent CI retains the disposable full-restore proof, while the production backup automation validates each custom-format dump with `pg_restore --list` before upload.

Phase 16 now includes automated daily backup and retention. Storage credentials remain external secrets and no production dump is stored in Git or a GitHub Actions artifact.

## Automated production backup

`.github/workflows/backup-automation.yml` runs daily at **03:20 UTC** and is also manually dispatchable. The workflow invokes `scripts/operations/postgres-backup.sh`.

The backup path is intentionally fail-closed. It requires all of the following environment-backed secrets:

- `PRODUCTION_DATABASE_URL` -> script `DATABASE_URL`;
- `BACKUP_S3_BUCKET`;
- `BACKUP_AWS_ACCESS_KEY_ID`;
- `BACKUP_AWS_SECRET_ACCESS_KEY`;
- `BACKUP_AWS_REGION`;
- optional `BACKUP_AWS_SESSION_TOKEN`;
- optional `BACKUP_S3_ENDPOINT_URL` for an S3-compatible endpoint supported by the AWS CLI.

Missing required credentials fail the scheduled run instead of silently skipping the backup.

The script:

1. uses the pinned PostgreSQL 18.6 image/digest already used by permanent CI;
2. creates a custom-format `pg_dump` with ownership/ACL metadata excluded;
3. rejects an empty artifact;
4. validates the dump catalogue with `pg_restore --list`;
5. computes SHA-256;
6. creates a non-secret JSON manifest containing creation time, source Git SHA, PostgreSQL image pin, retention days, and dump filename;
7. uploads dump, checksum, and manifest to the controlled S3 prefix with server-side AES-256 encryption requested;
8. removes only objects older than the retention cutoff and only beneath the controlled `pokemon-rpg/postgres/postgres-*` prefix;
9. fails if an attempted deletion escapes that prefix.

The canonical baseline retention is **30 days**. Bucket-side versioning/object lock/lifecycle may add stronger retention, but must not weaken this baseline without an operational review.

## Permanent CI proof

`.github/workflows/ci.yml` runs `Logical backup and disposable restore proof` against the pinned PostgreSQL 18.6 container on every applicable CI run.

That proof:

1. inserts a deterministic data probe into `players`;
2. records the migration count and a fingerprint of `(version, name, checksum)` from `schema_migrations`;
3. creates a full custom-format dump with `pg_dump`;
4. creates a new disposable database;
5. restores the dump with `pg_restore --exit-on-error`;
6. verifies the restored migration count;
7. verifies the restored migration-history fingerprint;
8. verifies the data probe exists with the same state.

`.github/workflows/security-integrity-proof.yml` additionally runs `db/proofs/phase16_backup_automation_e2e.sh`. That proof uses the real disposable PostgreSQL database and pinned dump image, while replacing only AWS with a local fake. It proves dump generation, structural validation, three-object upload contract, SSE flag, retention listing, and controlled expired-object deletion without contacting production storage.

A failure in any of these steps fails the applicable permanent gate.

## Operator restore procedure

Use credentials supplied by the deployment secret/environment layer. Never paste production credentials into Git, issues, logs, chat transcripts, or Drive documents.

For a selected backup generation:

1. retrieve the `.dump`, `.dump.sha256`, and `.dump.json` objects from the same generation;
2. verify the SHA-256 checksum before restore;
3. inspect the manifest and record its creation time/source Git SHA;
4. restore into a **new/disposable** PostgreSQL database first;
5. use `pg_restore --exit-on-error`;
6. verify migration history and representative durable state;
7. only then decide whether the restored database is eligible for traffic under the disaster-recovery procedure.

Example restore shape:

```bash
set -euo pipefail

sha256sum --check postgres-<generation>.dump.sha256

createdb "$DISPOSABLE_RESTORE_DATABASE"

pg_restore \
  --dbname "$DISPOSABLE_RESTORE_DATABASE_URL" \
  --exit-on-error \
  postgres-<generation>.dump
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
- Preserve the original backup generation until the restored database has passed validation.
- Treat `pg_restore` warnings/errors as failures unless explicitly reviewed and documented.
- Validate schema/migration history before routing application traffic to a restored database.
- Keep backup credentials and encryption material outside the repository.
- The backup AWS identity must be scoped to the configured backup bucket/prefix as narrowly as the provider permits.
- GitHub Actions artifacts are **not** the production backup destination.
- A failed scheduled backup is a CRITICAL operational alert; backup age >=26h is WARNING and >=36h is CRITICAL according to `docs/operations/observability-alerting.md`.

## Definition of valid restore evidence

A restore evidence record must identify the source environment/artifact, timestamp, PostgreSQL version, result of `pg_restore --exit-on-error`, migration-history comparison, representative state checks, and the Git SHA/run that executed the proof when applicable.
