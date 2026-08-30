# Release, rollback, restore and incident runbook

## Purpose

This is the canonical operator sequence for Phase 17 release/recovery work. It does not replace the detailed documents it references; it tells the operator which procedure to execute, in what order, where to stop, and what evidence must exist before traffic is admitted.

Detailed contracts:

- environment/release boundary: `docs/operations/environments-release.md`;
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
- more than one active Fly Machine could use the same Baileys session without an explicitly approved fencing design;
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

For Fly.io staging, also verify that the app identified by `STAGING_FLY_APP` already exists, the GitHub `staging` Environment is configured, and the Fly secret layer contains `DATABASE_URL`, `WHATSAPP_SESSION_KEY`, `WHATSAPP_AUTH_KEY_BASE64`, and `WHATSAPP_AUTH_KEY_VERSION` but does not contain `MIGRATOR_DATABASE_URL`.

If this environment needs its first WhatsApp session, also verify that no runtime is active with the same `WHATSAPP_SESSION_KEY` and that the provider version is eligible under `docs/operations/whatsapp-first-pairing.md`. Do not plan a release that depends on bypassing the pairing compatibility gate.

### A2. Control traffic

For a schema-changing release, stop or drain application traffic before migration. Do not allow old and new binaries to race against an in-transition schema unless an explicitly tested compatibility plan exists.

The current Baileys staging topology is intentionally one Machine. Deploys use `--strategy immediate`; brief worker downtime is accepted to avoid overlapping two active workers on the same WhatsApp session.

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

The currently pinned `@whiskeysockets/baileys@7.0.0-rc14` is intentionally blocked for live first pairing. A release that requires a new provider session must stop here until an approved compatible provider version/patch exists and passes the real-provider staging acceptance. Do not bypass the gate or insert auth manually.

Do not execute this step for an already bootstrapped session, ordinary redeploy, rollback or routine runtime restart.

### A7. Deploy the exact binary/revision

Deploy the same full SHA that was migrated/approved. Manual server-side code editing is not a valid normal release path.

For staging the canonical workflow consumes the already-published immutable GHCR tag, verifies its OCI revision label, copies it to:

```text
registry.fly.io/<staging-app>:sha-<full-40-char-git-sha>
```

and deploys that exact image with:

```bash
flyctl deploy \
  --app "$FLY_APP" \
  --config fly.staging.toml \
  --image "registry.fly.io/${FLY_APP}:sha-${DEPLOY_REVISION}" \
  --ha=false \
  --strategy immediate \
  --env "DEPLOY_REVISION=${DEPLOY_REVISION}" \
  --now

flyctl scale count 1 --app "$FLY_APP" --config fly.staging.toml --yes
```

`--ha=false` prevents Fly from creating standby redundancy on first deploy. The scale command reasserts the one Machine invariant after deployment. Do not replace the immutable SHA image with `:main`.

### A8. Post-deploy smoke gate

The canonical smoke implementation is `pnpm ops:smoke:application`. It is read-only and release-bound. It must run against the runtime database credential and expected provider session, not a migrator credential.

For a real staging/production deployment, success requires all application checks plus exact provider evidence:

- deployed `DEPLOY_REVISION` matches the expected full SHA;
- `WHATSAPP_SESSION_KEY` matches the intended session;
- provider state is `CONNECTED`;
- heartbeat is fresh;
- `providerLiveHealth` is `HEALTHY`;
- `finalPostDeploySmokeComplete` is `true`.

The staging runtime deploy workflow retries this smoke for a bounded window after Fly reports the Machine started. A process merely being alive is not sufficient release evidence.

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

If compatibility is proven, Fly staging rollback uses the previously published immutable image, not a rebuild and not the mutable `main` tag:

```bash
ROLLBACK_SHA="<previous-known-good-full-sha>"
flyctl deploy \
  --app "$FLY_APP" \
  --config fly.staging.toml \
  --image "registry.fly.io/${FLY_APP}:sha-${ROLLBACK_SHA}" \
  --ha=false \
  --strategy immediate \
  --env "DEPLOY_REVISION=${ROLLBACK_SHA}" \
  --now
flyctl scale count 1 --app "$FLY_APP" --config fly.staging.toml --yes
```

Then rerun the canonical post-deploy smoke with `DEPLOY_REVISION=$ROLLBACK_SHA`. The rollback is not complete until the exact rollback revision/session produces fresh provider-live evidence.

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
Runtime image digest/tag:
Fly app/Machine id (when applicable):
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

This runbook documents the procedures required by Phase 17.12 and the code-level Fly deployment/smoke contract. It does not itself prove the external infrastructure-dependent items.

The following remain separately gated until real evidence exists:

- **17.2** real staging PostgreSQL release/provider-equivalent environment;
- **17.3** real CI/CD execution connected to the configured Fly.io staging target;
- **17.5** real post-deploy smoke against an actually deployed provider-connected revision/session;
- production backup/alert/provider validations that explicitly require the eventual production target.
