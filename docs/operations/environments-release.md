# Environment and release contract

## Purpose

Phase 17 separates development, test, staging and production as operational environments rather than aliases for the same database or credentials. The application already validates `APP_ENV` as one of `development`, `test`, `staging` or `production`; this document defines the deployment contract around that code-level boundary.

The contract is fail-closed. Missing production/staging role separation for a migration, an unknown environment, an unpinned deployment revision or a failed migration/deployment smoke blocks promotion.

## Environment matrix

| Environment | Durable PostgreSQL | WhatsApp/provider identity | Migration credential | Deployment policy |
| --- | --- | --- | --- | --- |
| `development` | local/disposable | fake/local unless explicitly testing provider integration | may reuse runtime credential | developer-controlled; never treated as release evidence |
| `test` | disposable CI/test database | fake/contract adapter; no production session | may reuse runtime credential | automated tests only |
| `staging` | dedicated PostgreSQL, isolated from production | dedicated staging auth/session when provider integration is enabled | mandatory for migration operations and distinct from runtime | release candidate only; same code path and PostgreSQL major version as production where possible |
| `production` | dedicated production PostgreSQL | production auth/session only | mandatory for migration operations and distinct from runtime | approved immutable revision only; no manual code edits as the normal deployment process |

### Isolation invariants

- Staging and production must never share a database, runtime login, migrator login, WhatsApp authentication/session state or backup prefix.
- Staging and production use the same application code paths and migration set for a given candidate SHA.
- PostgreSQL compatibility target is the repository-pinned PostgreSQL 18.6 baseline unless a separately approved infrastructure decision changes it.
- Environment secrets stay in the deployment secret/environment layer. They do not belong in Git, Drive, PR bodies, workflow logs or chat transcripts.
- Runtime and migrator PostgreSQL usernames must be different in staging/production whenever a migrator credential is supplied. The migration wrapper requires this separation.
- The long-running runtime must receive only its restricted `DATABASE_URL`; the runtime must not receive `MIGRATOR_DATABASE_URL`.
- Production startup must continue to fail when the database schema is not current.

## Fly.io staging runtime target

The approved Phase 17 staging runtime target is Fly.io, using `fly.staging.toml` and the manual `Staging Runtime Deploy` GitHub Actions workflow.

The repository contract is intentionally single-worker and provider-safe:

- primary Fly region is `gru` (São Paulo), aligned with the South America staging database region;
- the runtime is a worker with no HTTP service, no Fly Proxy service and no persistent volume;
- compute is `shared-cpu-1x` with 512 MB memory;
- shutdown uses `SIGTERM` with a 30-second best-effort timeout;
- restart policy is `always`;
- deployment uses exactly one Machine;
- `fly deploy` is invoked with `--ha=false` so Fly does not create a standby Machine on first deploy;
- deployment strategy is `--strategy immediate` so the old Baileys worker is stopped before replacement rather than deliberately overlapping two workers on the same WhatsApp session;
- `flyctl scale count 1 --yes` is applied after deploy as a second single-Machine invariant;
- the workflow deploys only `sha-<full-git-sha>` images and never the mutable `main` tag;
- the canonical GHCR image is verified by its `org.opencontainers.image.revision` label, copied to `registry.fly.io/<app>:sha-<full-git-sha>`, and that exact image is deployed;
- `DEPLOY_REVISION` is injected as non-secret release metadata for provider-live evidence;
- database/runtime/auth secrets remain in the Fly app secret vault and are never written into `fly.staging.toml`.

Before the first real staging deployment, the Fly app must already exist and the following runtime secrets must be provisioned directly in its secret layer: `DATABASE_URL`, `WHATSAPP_SESSION_KEY`, `WHATSAPP_AUTH_KEY_BASE64`, and `WHATSAPP_AUTH_KEY_VERSION`. `MIGRATOR_DATABASE_URL` must not be present in the Fly runtime app. The workflow validates secret names only; Fly does not return their values.

The GitHub `staging` Environment must provide `STAGING_FLY_APP`, `FLY_API_TOKEN`, `STAGING_RUNTIME_DATABASE_URL`, and `STAGING_WHATSAPP_SESSION_KEY` for the controlled deployment/smoke workflow. These values are external configuration, not repository content.

## Controlled migration step

Numbered migrations are applied only by the migrator role and remain governed by the existing checksum/advisory-lock/transaction contract in `src/platform/db/migrations.ts`.

For staging or production release candidates use:

```bash
APP_ENV=staging \
DATABASE_URL="$STAGING_RUNTIME_DATABASE_URL" \
MIGRATOR_DATABASE_URL="$STAGING_MIGRATOR_DATABASE_URL" \
DEPLOY_REVISION="<full-40-char-git-sha>" \
  bash scripts/operations/release-migrate.sh
```

Production uses `APP_ENV=production` and production-scoped credentials. The script:

1. rejects development/test and unknown environments;
2. requires both runtime and migrator database URLs;
3. requires distinct runtime and migrator PostgreSQL roles;
4. requires a full 40-character commit SHA as `DEPLOY_REVISION`;
5. records non-secret structured start/complete events containing only environment and revision;
6. derives `MIGRATION_APPLIED_BY` as `release:<environment>:<revision>` unless an explicit audit identity is supplied;
7. invokes the canonical `pnpm db:migrate` runner, which verifies migration sequence/checksums, serializes migrators with a PostgreSQL advisory lock, wraps each pending migration in a transaction and verifies the final migration history.

The migrator credential is an operator/release credential. It is not a normal runtime dependency. `loadConfig()` therefore permits staging/production runtime processes with only `DATABASE_URL`; when `MIGRATOR_DATABASE_URL` is explicitly supplied, shared runtime/migrator usernames are still rejected.

## Initial administrative bootstrap

A newly created staging/production database has no authorized admin principal. The first principal cannot be created through the ordinary Tier 4 `admin.role.assign` workflow because that workflow itself requires an already-authorized proposer and independent approval.

For a genuinely new environment only, run the one-time `pnpm ops:bootstrap:admin` ceremony documented in `docs/operations/initial-admin-bootstrap.md`. It uses the schema-owning migrator credential, creates one `OWNER_SECURITY_ADMIN` principal with a GLOBAL scope, appends audit evidence and leaves an immutable bootstrap marker. Exact replay is idempotent; conflicting identity/release/environment state fails closed. After this marker exists, later admin role changes return to the normal governed admin operation surface.

The release order is:

1. bootstrap/rotate PostgreSQL roles with `db/bootstrap/roles.sql` when required;
2. run `scripts/operations/release-migrate.sh` while runtime traffic is stopped for schema-changing releases;
3. reconcile runtime grants with `db/bootstrap/runtime_grants.sql` as the migrator role;
4. on a genuinely new environment only, execute the initial administrative bootstrap ceremony;
5. run `pnpm db:verify` using only the runtime credential;
6. confirm the exact immutable runtime image exists for the same candidate SHA;
7. run the manual Fly.io staging runtime deployment workflow;
8. wait for the exact revision/session to report fresh provider-live `CONNECTED` evidence;
9. require the canonical post-deploy smoke to return `providerLiveHealth=HEALTHY` and `finalPostDeploySmokeComplete=true`;
10. only then admit the release as externally proven.

## CI evidence

Permanent CI exercises the controlled migration command against a real disposable PostgreSQL database using `APP_ENV=staging`, distinct migrator/runtime roles and the exact CI commit SHA. The same proof reconciles runtime grants, verifies the schema through the restricted runtime role and exercises the one-shot initial admin bootstrap with exact replay/conflict/privilege checks.

Permanent Release Foundation CI also statically proves the Fly.io deployment contract: single Machine, no HTTP/mounts, immutable-image-only deployment, no runtime migrator credential, exact revision injection and provider-live post-deploy smoke. This is repository evidence for the pipeline design; it is not evidence that an external Fly app has actually been configured or deployed.

## Deliberately still open

This foundation does **not** by itself close these Phase 17 requirements:

- 17.2: an actual staging database release and production-equivalent adapter configuration where possible;
- 17.3: the approved Fly.io runtime target configured externally and a real immutable deployment completed through the workflow;
- 17.5: real provider-connected post-deploy smoke evidence from that deployed revision/session.

Those items close only after the external target, credentials and release are configured and proven. No workflow or document may substitute a simulated target for that evidence.
