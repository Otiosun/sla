# Railway staging runtime

## Purpose

Railway is the canonical staging runtime target for the current zero-cost Phase 17 validation window. It runs the already-built immutable GHCR runtime image; it is not a source-build environment and it is not the production hosting decision.

Fly.io remains an inactive fallback. Its existing workflow and `fly.staging.toml` stay in the repository so the project does not discard the previously validated deployment path.

## Fixed target

- GitHub Environment: `staging`
- Railway environment: `staging`
- Railway service: `pokemon-rpg-whatsapp-staging`
- GitHub Environment secret: `RAILWAY_TOKEN`
- GitHub Environment variable: `STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging`
- Canonical workflow: `Railway Staging Runtime Deploy`
- Canonical image: `ghcr.io/otiosun/sla:sha-<full-40-char-git-sha>`
- Fly.io: fallback only while the zero-cost validation window is active

The Railway Project Token is created for the staging project/environment and pasted directly into the GitHub `staging` Environment as `RAILWAY_TOKEN`. Never put its value in Git, Drive, PR bodies, workflow output, screenshots, shell history, or chat transcripts.

## Runtime variables

The Railway service must have these variables before a canonical deployment:

- `DATABASE_URL`
- `WHATSAPP_SESSION_KEY`
- `WHATSAPP_AUTH_KEY_BASE64`
- `WHATSAPP_AUTH_KEY_VERSION`
- `APP_ENV=staging`
- `DEPLOY_REVISION=<exact deployed full SHA>`
- `LOG_LEVEL=info`
- `WHATSAPP_HEALTH_HEARTBEAT_MS=30000`

`MIGRATOR_DATABASE_URL` is forbidden in the long-running Railway runtime. Schema changes remain a separate release/migrator ceremony.

The GitHub `staging` Environment also supplies `STAGING_RUNTIME_DATABASE_URL` and `STAGING_WHATSAPP_SESSION_KEY` to the read-only post-deploy smoke. Their values are not Railway configuration output and must not be printed.

## One-worker invariant

Baileys cannot safely run two active workers on the same WhatsApp session in this topology. Railway's normal singleton deployment strategy starts the replacement before removing the previous deployment, so merely configuring one replica is not sufficient for this project.

The Railway service must be preconfigured with exactly one configured replica before routine canonical deploys. Replica topology is infrastructure bootstrap, not a per-release mutation: the project-scoped `RAILWAY_TOKEN` is intentionally kept narrow, and the canonical workflow must not call `railway scale` merely to rewrite the already-required singleton topology.

The singleton read must also work while the service is intentionally offline before the first canonical deploy. `railway service list --json` can report `replicas: null` when no deployment is serving, so runtime instance counts are not accepted as configuration evidence. The workflow uses `railway service list --environment staging --json` only to resolve the unique service ID, then uses the official Railway GraphQL path through `railway api` to read that environment's configuration with `config(decryptVariables:false)`. It sums `deploy.multiRegionConfig.*.numReplicas` (or the legacy configured `deploy.numReplicas` when no multi-region map exists) and fails closed unless the result is exactly one. The response is piped directly into topology parsing; plaintext Railway variables are neither requested nor logged. `railway environment config --json` is deliberately not used because that CLI command requests decrypted variables.

The canonical workflow therefore accepts brief staging downtime and performs an explicit non-overlapping replacement:

1. verify the service is preconfigured with exactly one configured replica;
2. inspect the latest successful deployment and reject transitional deployment states;
3. when one successful deployment exists, run `railway down --service "$RAILWAY_SERVICE" --environment staging --yes`;
4. wait until that deployment is `REMOVED` or absent;
5. stage the exact `DEPLOY_REVISION` with `--skip-deploys`;
6. connect the exact immutable GHCR `sha-<full-sha>` image;
7. wait for the replacement deployment to reach `SUCCESS`;
8. run the provider-live post-deploy smoke.

If the singleton preflight fails, correct the Railway service topology through the staging infrastructure bootstrap ceremony before rerunning the canonical workflow. Do not replace the Project Token with a broader account/workspace credential merely to make `railway scale` available to CI.

If the previous deployment cannot be proven stopped, the replacement is not started. Do not bypass this gate to obtain zero downtime.

## Normal deployment

Routine staging deployments are launched only from canonical `main` through the GitHub Actions workflow `Railway Staging Runtime Deploy`. Browser-side source edits or manual server deployment are not normal release evidence.

The workflow requires a full 40-character `GITHUB_SHA`, pulls `ghcr.io/otiosun/sla:sha-${GITHUB_SHA}`, and verifies that the OCI label `org.opencontainers.image.revision` equals the same SHA before mutating Railway.

It does not enumerate Railway variables because Railway's variable-list API exposes secret values. Required runtime variables remain an external provisioning invariant; runtime startup and the final smoke fail closed when required configuration is missing or unusable.

The workflow verifies the preconfigured singleton topology, rejects concurrent/transitional deployments, enforces the non-overlapping one-worker sequence above, and waits for Railway deployment `SUCCESS`.

A Railway `SUCCESS` state alone is insufficient. Final success requires `pnpm ops:smoke:application` to report all three predicates for the exact revision/session:

- `passed === true`
- `providerLiveHealth === "HEALTHY"`
- `finalPostDeploySmokeComplete === true`

## Failure handling

Before source mutation, a failure leaves the previous deployment untouched unless the workflow has already entered the explicit teardown step.

After the previous worker has been removed, any failure is fail-closed: do not start a second speculative worker, do not reset WhatsApp auth, and do not alter database state manually to make the gate pass. Diagnose the workflow/deployment, then rerun the same immutable candidate or select a separately approved known-good SHA.

A free/trial Railway deployment may also remain queued during temporary capacity restrictions. A queued deployment is not a release failure until the bounded workflow window expires, but it is not release evidence either.

## Rollback

Rollback must use a known-good immutable SHA whose compatibility with the current database schema/state is understood. The safe staging rollback procedure uses the same non-overlapping sequence as a forward deploy: verify the preconfigured singleton topology, stop the current worker, stage the rollback `DEPLOY_REVISION`, connect the known-good `sha-<rollback-sha>` image, wait for `SUCCESS`, then rerun the exact provider-live smoke.

Do not regenerate or delete WhatsApp authentication material during a code rollback. Do not rewrite migration history.

## Fly.io fallback

The repository retains `.github/workflows/staging-runtime-deploy.yml` and `fly.staging.toml`. They are inactive fallback infrastructure while Railway is canonical staging for the current validation window. Activating Fly again is an explicit infrastructure decision; it is not performed automatically by a Railway failure.

## Phase 17 evidence boundary

This document and the workflow contract do not close 17.3 or 17.5 by themselves. 17.3 requires the merged canonical workflow to complete a real Railway deployment of the exact canonical main revision. 17.5 requires the provider-connected post-deploy smoke to pass against that external deployment.
