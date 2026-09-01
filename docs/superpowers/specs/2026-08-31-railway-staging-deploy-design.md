# Railway Staging Deploy — Design

Date: 2026-08-31
Status: approved design, provider-safety refinement recorded during implementation
Base main: `22e152b5aca98d07f64bc5db939152b086937cbf`

## Context

The canonical staging deploy workflow currently targets Fly.io. The Fly path is already engineered and remains valuable as a fallback, but the current account cannot create the staging app without adding payment information. The project must continue at zero spend for now.

A Railway trial project/environment/service has been prepared manually as infrastructure bootstrap only:

- environment: `staging`
- service: `pokemon-rpg-whatsapp-staging`
- source: immutable GHCR image for the current canonical main SHA
- runtime variables/secrets are provisioned in Railway
- service remains offline until the canonical deploy workflow is ready

The code repository remains the source of truth for deploy logic. Manual Railway clicks do not satisfy Phase 17.3.

## Decision

Railway becomes the canonical staging runtime target for the current zero-cost validation window. Fly.io remains preserved in the repository as an inactive fallback; its workflow/configuration is not deleted.

The Railway path must preserve the same safety properties as the existing Fly staging path:

1. deploy only from canonical `main`;
2. deploy an immutable OCI image tagged by the exact Git commit SHA;
3. verify the OCI revision label before touching the target;
4. keep runtime-only secrets outside the repository;
5. never expose `MIGRATOR_DATABASE_URL` to the runtime;
6. run a single WhatsApp worker to avoid concurrent provider sessions;
7. wait for a settled successful deployment;
8. run the existing provider-live post-deploy smoke against the exact deployed revision;
9. fail closed if revision, topology, runtime health, or secret-boundary checks do not match expectations.

## Architecture

### Canonical image

The deploy workflow consumes:

`ghcr.io/otiosun/sla:sha-${GITHUB_SHA}`

The workflow logs in to GHCR with GitHub's short-lived token, pulls the image, and inspects `org.opencontainers.image.revision`. The value must equal the full `GITHUB_SHA` before Railway is mutated.

The workflow does not rebuild application code on Railway. Railway is a runtime target for the already-built canonical OCI artifact.

### Railway authentication

GitHub Actions authenticates to Railway with one project-scoped token stored in the GitHub `staging` Environment as `RAILWAY_TOKEN`.

The token is scoped to the Railway project/environment used for staging. No Railway account/workspace-wide token is required for normal deploys.

The token value must never appear in repository files, workflow output, screenshots, or chat transcripts.

### Railway target identity

The GitHub `staging` Environment stores non-secret Railway target identifiers as environment variables where practical, rather than hard-coding dashboard-generated IDs in workflow logic. The service's stable human-readable name remains `pokemon-rpg-whatsapp-staging`.

Expected configuration inputs:

- `RAILWAY_TOKEN` — secret, project-scoped
- `STAGING_RAILWAY_SERVICE` — variable, expected `pokemon-rpg-whatsapp-staging`

If Railway CLI/API requires project/environment IDs for deterministic non-interactive targeting, those IDs are added as GitHub Environment variables, never secrets unless Railway classifies them as credentials.

### Runtime secrets

The Railway service owns these runtime secrets/variables:

- `DATABASE_URL`
- `WHATSAPP_SESSION_KEY`
- `WHATSAPP_AUTH_KEY_BASE64`
- `WHATSAPP_AUTH_KEY_VERSION`
- `APP_ENV=staging`
- `DEPLOY_REVISION=<exact deployed SHA>`
- `LOG_LEVEL=info`
- `WHATSAPP_HEALTH_HEARTBEAT_MS=30000`

`MIGRATOR_DATABASE_URL` must be absent from the Railway runtime.

Railway's current CLI/API variable-list operations return variable values, not a names-only metadata view. The canonical workflow therefore must not enumerate the Railway variable collection merely to prove names: doing so would unnecessarily pull secrets into CI command output/state. Provisioning and absence of the migrator credential are an external preflight invariant documented in the operator runbook; the workflow itself supplies no migrator credential, and the final runtime/smoke gate fails closed when required runtime configuration is missing or unusable.

### Immutable source update

Each deploy uses a unique image tag `sha-${GITHUB_SHA}`. The Railway service source is updated to the exact tag for the requested canonical main revision, then that exact configuration is deployed.

Mutable tags such as `latest`, `main`, or `staging` are prohibited for the canonical path.

Image auto-update is disabled/ignored for this application path; CI owns promotion timing.

### Single-worker invariant

WhatsApp/Baileys state must not be served by overlapping workers. Configuring one Railway replica is necessary but not sufficient: Railway's normal singleton rollout starts the replacement before the previous deployment is removed, and can therefore overlap two processes even when the final replica count is one.

For this staging worker, provider safety takes precedence over zero downtime. The workflow must:

1. reject an already-transitioning Railway topology (`BUILDING`, `DEPLOYING`, `INITIALIZING`, `WAITING`, `QUEUED`, or `REMOVING`);
2. identify the current successful deployment when one exists;
3. call `railway down` for that deployment and wait until it is `REMOVED` or absent;
4. only after the old worker is proven stopped, configure exactly one replica and connect/deploy the replacement immutable image.

A short staging outage is accepted. The workflow must never start the replacement merely because the configured replica count is one if the previous Baileys worker has not been proven stopped.

A deployment is not GREEN merely because Railway accepted it. It must reach Railway's successful/running state and remain singular.

### Post-deploy smoke

After Railway reports the deployment successful, the workflow runs the existing `ops:smoke:application` command using the GitHub `staging` Environment smoke credentials:

- `STAGING_RUNTIME_DATABASE_URL`
- `STAGING_WHATSAPP_SESSION_KEY`
- `DEPLOY_REVISION=${GITHUB_SHA}`

The same existing contract remains mandatory:

- report `passed === true`;
- `providerLiveHealth === "HEALTHY"`;
- `finalPostDeploySmokeComplete === true`.

The smoke retries for a bounded stabilization window. If the exact revision never becomes healthy, the workflow fails.

## Workflow shape

The existing Fly workflow remains preserved as fallback. Railway gets its own canonical staging workflow rather than silently rewriting or deleting the Fly path.

The Railway workflow is `workflow_dispatch` only during this final validation phase and uses GitHub Environment `staging`.

High-level steps:

1. require `refs/heads/main` and a full 40-char SHA;
2. validate required Railway token/service identity without enumerating secret values;
3. checkout exact revision;
4. install exact Node/pnpm versions needed for existing smoke tooling;
5. pull and verify the immutable GHCR runtime image;
6. install/use a pinned Railway CLI version;
7. reject any pre-existing transitional deployment state;
8. stop the previous successful worker and prove it is removed;
9. enforce exactly one configured replica;
10. stage `DEPLOY_REVISION=${GITHUB_SHA}` without a standalone redeploy;
11. update Railway service source to `ghcr.io/otiosun/sla:sha-${GITHUB_SHA}` without using mutable tags;
12. wait for a new terminal deployment and require `SUCCESS`;
13. run provider-live post-deploy smoke;
14. log out/clean up transient registry/auth state.

## CLI vs Public API implementation choice

The implementation uses the pinned Railway CLI for authentication, service targeting, source update, status, teardown and scaling. Public API use remains a fallback only if a future CLI version can no longer provide deterministic non-interactive operations required by this contract.

The implementation must not depend on browser clicks for routine deployments.

## Testing strategy

Implementation follows TDD.

Before the production workflow is added, contract tests must fail against the current repository because the Railway canonical deploy contract does not yet exist. Tests then become GREEN only after the workflow/script implements the design.

Tests assert at minimum:

- canonical main-only guard;
- exact 40-character SHA requirement;
- immutable `sha-${GITHUB_SHA}` image construction;
- OCI revision verification exists;
- Railway project token is referenced only as a GitHub secret;
- Railway secret values are not enumerated into CI merely for configuration-name checks;
- no secret literal values are committed;
- `MIGRATOR_DATABASE_URL` is absent from workflow runtime inputs and forbidden by operator contract;
- service name/target is explicit;
- transitional deployment states fail closed;
- explicit previous-worker teardown occurs before replacement;
- single-replica enforcement exists;
- post-deploy smoke preserves the three existing success predicates;
- Fly fallback files remain present and are not made the canonical zero-cost staging path.

The repository's existing CI suite must remain GREEN.

## Rollback and failure behavior

If deployment fails before Railway changes are applied, the existing offline/previous Railway deployment is untouched.

Once the canonical workflow intentionally removes the previous worker, subsequent failure leaves staging unavailable rather than starting an overlapping speculative worker. No automatic destructive cleanup of WhatsApp auth state is allowed. Diagnosis/retry uses the same immutable candidate or a separately selected known-good immutable SHA.

Rollback is performed through the same non-overlapping sequence with a previously known-good immutable SHA/image. WhatsApp auth material and database state are not reset as part of rollback.

## User interaction boundary

The only expected manual credential ceremony is:

1. create a Railway project-scoped token for the `staging` project/environment;
2. add it directly to the GitHub `staging` Environment as `RAILWAY_TOKEN` without exposing it to the assistant or repository;
3. add `STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging` as a GitHub Environment variable if not already present.

All normal subsequent staging deploys must be launchable through the canonical GitHub Actions workflow without dashboard reconfiguration.

## Phase 17 acceptance mapping

This design alone closes nothing.

Phase 17.3 closes only after the Railway workflow is merged to canonical main and a real external deploy of the exact canonical main revision succeeds reproducibly without a manual server deployment procedure.

Phase 17.5 closes only after the post-deploy provider-live smoke succeeds against that external Railway deployment.

The canonical overall progress remains 97.60% until those acceptance conditions are satisfied.

## Non-goals

- No production migration to Railway is decided here.
- No deletion of Fly.io workflow/configuration.
- No change to WhatsApp message semantics, PVP, content, or admin features.
- No database migration or schema change.
- No regeneration/reset of WhatsApp auth material.
- No automatic merge of the implementation PR.
