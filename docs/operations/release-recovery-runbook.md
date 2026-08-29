# Release, rollback, restore and incident runbook

## Purpose

This is the canonical operator sequence for Phase 17 release/recovery work. It does not replace the detailed documents it references; it tells the operator which procedure to execute, in what order, where to stop, and what evidence must exist before traffic is admitted.

Detailed contracts:

- environment/release boundary: `docs/operations/environments-release.md`;
- initial admin bootstrap: `docs/operations/initial-admin-bootstrap.md`;
- backup artifact and restore validation: `docs/operations/backup-restore.md`;
- replacement-database recovery and logical rollback: `docs/operations/disaster-recovery.md`;
- incident classification/containment: `docs/operations/incident-response.md`;
- metrics/alerts: `docs/operations/observability-alerting.md`;
- admin operations: `docs/operations/admin-operator-manual.md`.

## Global stop rules

Stop the release/recovery and do not admit traffic when any of these is true:

- the candidate is not identified by a full immutable Git SHA;
- staging/production runtime and migrator database roles are shared;
- the target database/environment is ambiguous;
- migration verification fails or migration history/checksum drifts;
- required backup/restore evidence is unavailable for a risky production change;
- a post-deploy smoke check fails or has not been performed when the release requires it;
- a secret, WhatsApp auth session or backup artifact appears to be shared between staging and production;
- provider authentication/pairing is unavailable and the deployment depends on creating a new provider session;
- operator evidence is incomplete enough that the next action cannot be audited.

Never make a failing gate green by editing the production database manually.

## A. Deploy procedure

### A1. Preflight

Record a release evidence entry with:

- environment (`staging` or `production`);
- full candidate SHA;
- operator/change identifier;
- runtime target identifier;
- PostgreSQL target identifier;
- runtime database role identity (name only, no secret);
- migrator role identity (name only, no secret);
- current backup age/last validated restore evidence when applicable;
- expected WhatsApp/provider session identity (name/key only, no auth material).

Verify staging and production isolation before continuing.

### A2. Control traffic

For a schema-changing release, stop or drain application traffic before migration. Do not allow old and new binaries to race against an in-transition schema unless an explicitly tested compatibility plan exists.

### A3. Run controlled migration

Use the canonical migration wrapper with the exact candidate revision:

```bash
APP_ENV=<staging|production> \
DATABASE_URL="$RUNTIME_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$MIGRATOR_DATABASE_URL" \
DEPLOY_REVISION="<full-40-char-git-sha>" \
  bash scripts/operations/release-migrate.sh
```

A failure stops the deployment.

### A4. Reconcile runtime grants

As the migrator role, reconcile the restricted runtime grants using `db/bootstrap/runtime_grants.sql`. Runtime must not gain schema-owner/migrator authority.

### A5. Initial admin only on a new environment

If and only if this is a genuinely new staging/production database with no administrative principal, follow `docs/operations/initial-admin-bootstrap.md` and execute `pnpm ops:bootstrap:admin` with the release-bound confirmation.

Do not rerun bootstrap to repair ordinary role-management problems.

### A6. Verify schema through the runtime identity

```bash
APP_ENV=<staging|production> \
DATABASE_URL="$RUNTIME_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$MIGRATOR_DATABASE_URL" \
  pnpm db:verify
```

The restricted runtime identity must pass schema verification.

### A7. Deploy the exact binary/revision

Deploy the same full SHA that was migrated/approved. Manual server-side code editing is not a valid normal release path.

### A8. Post-deploy smoke gate

Run the canonical post-deploy smoke suite when it exists for the target. Until Phase 17.5 is closed with a real smoke implementation, this runbook must not be used as evidence that production release readiness is complete.

At minimum a future real smoke gate must prove readiness/schema, one safe read path, provider/runtime health where enabled, and no unexpected critical backlog/error signal.

If smoke fails: remove/keep traffic away and move to the rollback/incident decision below.

### A9. Admit traffic and observe

Only after all required gates pass:

1. admit normal traffic;
2. monitor database errors/conflicts, Inbox/Outbox backlog, WhatsApp connection state and critical alerts;
3. record release completion time and smoke/evidence identifiers.

## B. Rollback decision

Rollback is not synonymous with "deploy the previous commit".

### Code-only rollback

A previous binary may be redeployed only when its compatibility with the current database schema/state is explicitly known. Never assume an older binary can safely operate a newer schema after a migration.

If compatibility is not proven, keep traffic contained and use state recovery instead.

### State/data rollback

For a bad data/application change, the canonical model is logical recovery:

1. select a known-good validated backup;
2. restore it into a replacement database;
3. validate schema history and representative state;
4. forward-migrate the replacement to the required current schema when safe;
5. cut over only after verification.

Do not execute a destructive automatic down-migration chain and do not delete/edit `schema_migrations` history.

Follow `docs/operations/disaster-recovery.md`.

## C. Restore procedure

### C1. Select one complete backup generation

Retrieve the matching `.dump`, `.dump.sha256` and `.dump.json` objects. Record artifact identifier, creation time, source SHA/environment and PostgreSQL version.

### C2. Verify before restore

Verify SHA-256 and inspect the manifest. A mismatched/incomplete generation is rejected.

### C3. Restore into a replacement/disposable database

Never overwrite the damaged live database in place.

```bash
sha256sum --check postgres-<generation>.dump.sha256
pg_restore \
  --dbname "$RECOVERY_DATABASE_URL" \
  --exit-on-error \
  postgres-<generation>.dump
```

### C4. Validate durable state

Before cutover verify:

- migration count and ordered `(version, name, checksum)` history;
- representative player state;
- economy/ledger and admin audit evidence relevant to the incident;
- active battle/encounter state when applicable;
- Inbox/Outbox state when replay/delivery matters;
- active content release pointers.

### C5. Forward-migrate if required

If restored migration history is a valid immutable prefix of the current repo, use the normal migrator and then `pnpm db:verify`. Do not rewrite migration history to force compatibility.

### C6. Cut over

Only a validated replacement is eligible for the deployment secret/config cutover. Preserve the old/damaged database as incident evidence until the incident is closed.

## D. Incident procedure

### D1. Declare and correlate

Create/record an incident identifier and start time. Identify current environment, deployed SHA and affected domain.

### D2. Contain first

Stop or isolate writes when continued execution can increase corruption, duplication or replay. Do not attempt speculative fixes while the blast radius is unknown.

### D3. Preserve evidence

Preserve relevant logs, audit rows, failed database/provider state, queue/backlog evidence and release identifiers. Never delete the original evidence merely because a recovery attempt succeeds.

### D4. Classify

Use `docs/operations/incident-response.md`. Common branches include:

- database/integrity;
- economy/reward duplication;
- admin/security;
- Inbox/Outbox/replay;
- battle/encounter invariant;
- provider/WhatsApp outage or auth-session loss;
- release/migration failure.

### D5. Choose recovery action

Use the least destructive safe path:

- transient infrastructure fault with intact state: recover infrastructure and verify;
- bad admin/domain mutation with supported semantic compensation: use the governed compensation path and preserve both audit records;
- state corruption or unsafe schema/application mismatch: replacement-database restore/logical rollback;
- provider pairing unavailable: fail closed, preserve existing registered auth if intact, and do not display/log an unverified pairing code as if registration succeeded.

### D6. Validate before resolution

An incident is not resolved because the process restarted. Verify the affected business invariant, schema/history where relevant, queues/provider health and audit evidence.

### D7. Close with evidence

Record root/trigger classification, containment, recovery action, validation evidence, residual risks and follow-up items.

## Evidence template

Every deploy/recovery/incident record should contain at least:

```text
Environment:
Incident/change id:
Candidate/deployed SHA:
Operator(s):
Started at:
Completed at:
Database target/replacement id:
Runtime role:
Migrator role:
Migration result/evidence:
Backup generation (if used):
Restore checksum/result (if used):
Smoke/validation evidence:
Provider session state (non-secret):
Traffic admitted at:
Rollback/recovery action (if any):
Residual risk / follow-up:
```

Do not put passwords, connection strings with credentials, encryption keys, WhatsApp auth blobs/QRs or raw backup data in this record.

## Phase 17 boundaries

This runbook documents the procedures required by Phase 17.12. It does not itself prove the external infrastructure-dependent items.

The following remain separately gated until real evidence exists:

- **17.2** real staging PostgreSQL/provider-equivalent environment;
- **17.3** reproducible CI/CD connected to an approved runtime target;
- **17.5** real post-deploy smoke implementation;
- production backup/alert/provider validations that explicitly require the eventual production target.
