# Release, rollback, restore and incident runbook

## Purpose

This is the canonical operator sequence for Phase 17 release/recovery work. It does not replace the detailed documents it references; it tells the operator which procedure to execute, in what order, where to stop, and what evidence must exist before traffic is admitted.

Detailed contracts:

- environment/release boundary: `docs/operations/environments-release.md`;
- Railway staging runtime: `docs/operations/railway-staging-runtime.md`;
- initial admin bootstrap: `docs/operations/initial-admin-bootstrap.md`;
- first WhatsApp provider session: `docs/operations/whatsapp-first-pairing.md`;
- backup artifact and restore validation: `docs/operations/backup-restore.md`;
- replacement-database recovery and logical rollback: `docs/operations/disaster-recovery.md`;
- incident classification/containment: `docs/operations/incident-response.md`;
- metrics/alerts: `docs/operations/observability-alerting.md`;
- admin operations: `docs/operations/admin-operator-manual.md`.

## Global stop rules

Stop the release/recovery and do not admit traffic when any of these is true:

- the candidate is not identified by a full immutable Git SHA;
- staging/production runtime and migrator database roles are shared for migration operations;
- the long-running runtime has access to `MIGRATOR_DATABASE_URL`;
- the target database/environment is ambiguous;
- migration verification fails or migration history/checksum drifts;
- required backup/restore evidence is unavailable for a risky production change;
- a post-deploy smoke check fails or has not been performed when the release requires it;
- a secret, WhatsApp auth session or backup artifact appears to be shared between staging and production;
- provider authentication/pairing is unavailable and the deployment depends on creating a new provider session;
- more than one active worker could use the same Baileys session without an explicitly approved fencing design;
- the previous Railway worker cannot be proven removed before its replacement starts;
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

For canonical Railway staging, verify that GitHub Environment `staging` is configured with `RAILWAY_TOKEN`, `STAGING_RUNTIME_DATABASE_URL`, `STAGING_WHATSAPP_SESSION_KEY`, and `STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging`. Verify the Railway service contains `DATABASE_URL`, `WHATSAPP_SESSION_KEY`, `WHATSAPP_AUTH_KEY_BASE64`, `WHATSAPP_AUTH_KEY_VERSION`, `APP_ENV`, `DEPLOY_REVISION`, `LOG_LEVEL`, and `WHATSAPP_HEALTH_HEARTBEAT_MS`, and does not contain `MIGRATOR_DATABASE_URL`.

Fly.io remains a fallback only. If it is deliberately activated, use the existing Fly-specific preflight in `docs/operations/environments-release.md` rather than mixing Fly and Railway credentials.

If this environment needs its first WhatsApp session, also verify that no runtime is active with the same `WHATSAPP_SESSION_KEY` and that the provider version is eligible under `docs/operations/whatsapp-first-pairing.md`. Do not plan a release that depends on bypassing the pairing compatibility gate.

### A2. Control traffic

For a schema-changing release, stop or drain application traffic before migration. Do not allow old and new binaries to race against an in-transition schema unless an explicitly tested compatibility plan exists.

The current Baileys staging topology is intentionally one worker. Railway normally brings a replacement online before removing the previous deployment, so the canonical workflow explicitly executes `railway down` and waits for the previous successful deployment to become `REMOVED` before connecting the replacement image. Brief worker downtime is accepted to prevent two active processes from sharing the same WhatsApp session.

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
  pnpm db:verify
```

The restricted runtime identity must pass schema verification without a migrator credential.

### A6.1. Bootstrap the first WhatsApp session only when required

For a genuinely new provider session only, follow `docs/operations/whatsapp-first-pairing.md` and run:

```bash
pnpm ops:bootstrap:whatsapp
```

The ceremony must use the same release-bound full `DEPLOY_REVISION`, restricted runtime database identity, intended `WHATSAPP_SESSION_KEY` and auth-encryption key/version that the runtime will use. No runtime may hold the same session advisory lease while pairing runs.

Do not execute this step for an already bootstrapped session, ordinary redeploy, rollback or routine runtime restart.

### A7. Deploy the exact binary/revision

Deploy the same full SHA that was migrated/approved. Manual server-side code editing is not a valid normal release path.

For staging, dispatch the GitHub Actions workflow `Railway Staging Runtime Deploy` from canonical `main`. The workflow must:

1. validate `refs/heads/main` and the full 40-character SHA;
2. pull `ghcr.io/otiosun/sla:sha-<full-40-char-git-sha>`;
3. verify `org.opencontainers.image.revision` equals that SHA;
4. verify the Railway runtime variable-name boundary and reject `MIGRATOR_DATABASE_URL`;
5. capture the previous successful deployment, run `railway down --service "$RAILWAY_SERVICE" --environment staging --yes`, and wait for `REMOVED` when a previous worker exists;
6. enforce exactly one Railway replica;
7. stage `DEPLOY_REVISION=<full-sha>` with `--skip-deploys`;
8. connect the exact immutable GHCR image source;
9. wait for the replacement deployment to reach `SUCCESS`;
10. run the exact provider-live smoke.

Do not replace the immutable SHA image with a mutable tag and do not use `railway up` to rebuild/upload source for the canonical path.

#### Fly.io fallback

If Railway is deliberately suspended and Fly.io is explicitly reactivated, the preserved fallback workflow remains `.github/workflows/staging-runtime-deploy.yml` with `fly.staging.toml`. Its `--ha=false`, `--strategy immediate`, immutable image, and one-Machine constraints remain mandatory. Do not silently fail over from Railway to Fly during an incident.

### A8. Post-deploy smoke gate

The canonical smoke implementation is `pnpm ops:smoke:application`. It is read-only and release-bound. It must run against the runtime database credential and expected provider session, not a migrator credential.

For a real staging/production deployment, success requires all application checks plus exact provider evidence:

- deployed `DEPLOY_REVISION` matches the expected full SHA;
- `WHATSAPP_SESSION_KEY` matches the intended session;
- provider state is `CONNECTED`;
- heartbeat is fresh;
- `providerLiveHealth` is `HEALTHY`;
- `finalPostDeploySmokeComplete` is `true`.

The Railway staging runtime workflow retries this smoke for a bounded window after the replacement deployment reaches `SUCCESS`. A process merely being alive is not sufficient release evidence.

If smoke fails: keep the release unapproved and move to the rollback/incident decision below.

### A9. Admit traffic and observe

Only after all required gates pass:

1. admit normal traffic;
2. monitor database errors/conflicts, Inbox/Outbox backlog, WhatsApp connection state and critical alerts;
3. record release completion time and smoke/evidence identifiers.

## B. Rollback decision

Rollback is not synonymous with "deploy the previous commit".

### Code-only rollback

A previous binary may be redeployed only when its compatibility with the current database schema/state is explicitly known. Never assume an older binary can safely operate a newer schema after a migration.

For Railway staging, rollback uses a previously known-good immutable GHCR SHA through the same non-overlapping one-worker sequence as forward deployment:

1. identify `ROLLBACK_SHA=<previous-known-good-full-sha>`;
2. stop the current Railway worker and prove it is removed;
3. stage `DEPLOY_REVISION=$ROLLBACK_SHA` without a standalone redeploy;
4. connect `ghcr.io/otiosun/sla:sha-${ROLLBACK_SHA}` as the service source;
5. wait for Railway deployment `SUCCESS`;
6. rerun the canonical post-deploy smoke with `DEPLOY_REVISION=$ROLLBACK_SHA`.

The rollback is not complete until the exact rollback revision/session produces fresh provider-live evidence. Do not regenerate WhatsApp auth during rollback.

If Fly.io fallback is the deliberately active target, use its preserved immutable-image rollback procedure from `docs/operations/environments-release.md`.

If binary/database compatibility is not proven, keep traffic contained and use state recovery instead.

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
Runtime image digest/tag:
Railway service/deployment id (when applicable):
Fly app/Machine id (fallback when applicable):
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

This runbook documents the procedures required by Phase 17.12 and the code-level Railway deployment/smoke contract while preserving the Fly.io fallback. It does not itself prove the external infrastructure-dependent items.

The following remain separately gated until real evidence exists:

- **17.3** real CI/CD execution connected to the configured Railway staging target;
- **17.5** real post-deploy smoke against an actually deployed provider-connected Railway revision/session;
- production backup/alert/provider validations that explicitly require the eventual production target.
