# Railway Staging Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a canonical, reproducible Railway staging deployment path that consumes the immutable GHCR runtime image, preserves Fly.io as fallback, prevents overlapping Baileys workers, and requires the existing provider-live post-deploy smoke.

**Architecture:** Keep the existing Fly.io workflow/config as inactive fallback. Add a separate Railway `workflow_dispatch` workflow authenticated by a project-scoped `RAILWAY_TOKEN`, targeting `pokemon-rpg-whatsapp-staging`, using only `sha-${GITHUB_SHA}` GHCR images. Because Railway's normal singleton rollout can overlap old and new processes, explicitly remove the previous successful deployment before starting the replacement and accept brief staging downtime. Do not enumerate Railway variables in CI because the CLI returns secret values; required/forbidden runtime variables are an external preflight contract and the workflow never receives a migrator credential.

**Tech Stack:** GitHub Actions, GHCR, Railway CLI `@railway/cli@5.45.10`, Node.js 24.19.0, pnpm 11.23.0, Bash, jq, existing TypeScript post-deploy smoke.

**Spec:** `docs/superpowers/specs/2026-08-31-railway-staging-deploy-design.md`

## Global Constraints

- GitHub remains source of truth for deploy code; Drive remains source of truth for canonical progress/checkpoints.
- Railway is canonical staging for the current zero-cost validation window; Fly.io remains an inactive fallback.
- Routine deployments must not require browser-side server configuration after the one-time credential ceremony.
- Deploy only from `refs/heads/main` with a full 40-character Git SHA.
- Deploy only `ghcr.io/otiosun/sla:sha-${GITHUB_SHA}`; mutable `latest`, `main`, and `staging` tags are forbidden.
- Verify `org.opencontainers.image.revision == GITHUB_SHA` before any Railway mutation.
- Never commit, print, request, or enumerate secret values such as `RAILWAY_TOKEN`, `DATABASE_URL`, or `WHATSAPP_AUTH_KEY_BASE64`.
- The Railway service must already contain `DATABASE_URL`, `WHATSAPP_SESSION_KEY`, `WHATSAPP_AUTH_KEY_BASE64`, `WHATSAPP_AUTH_KEY_VERSION`, `APP_ENV`, `DEPLOY_REVISION`, `LOG_LEVEL`, and `WHATSAPP_HEALTH_HEARTBEAT_MS`.
- `MIGRATOR_DATABASE_URL` is forbidden in the long-running runtime and is never supplied by the deploy workflow.
- One WhatsApp session maps to one active worker. A replacement must not start until the prior successful Railway deployment is proven `REMOVED` or absent.
- Final Railway topology is exactly one replica: `us-east=1`, `us-west=0`, `eu-west=0`, `southeast-asia=0`.
- A deployment is GREEN only after Railway reaches `SUCCESS` and smoke returns `passed === true`, `providerLiveHealth === "HEALTHY"`, and `finalPostDeploySmokeComplete === true` for the exact SHA/session.
- No automatic merge. Merge requires explicit user authorization against the exact PR head SHA.
- 17.3 and 17.5 remain open until a merged canonical workflow performs the real external deploy and smoke successfully.

---

### Task 1: Define and prove the Railway deployment contract — RED

**Files:**
- Create: `db/proofs/phase17_railway_deploy_contract_e2e.sh`
- Modify: `.github/workflows/release-foundation-proof.yml`

**Interfaces:**
- Produces: `bash db/proofs/phase17_railway_deploy_contract_e2e.sh`, a static fail-closed deployment contract proof permanently executed by Release Foundation CI.

- [x] **Step 1: Create the failing contract proof before the implementation workflow exists.**

The proof requires main-only manual dispatch, immutable GHCR coordinates, pinned Railway CLI, explicit target identity, no mutable tags/source build, no secret enumeration, provider-safe teardown, exact one-replica topology, exact revision staging, Railway deployment polling, provider-live smoke, and preserved Fly fallback files.

- [x] **Step 2: Execute RED through a temporary PR-only proof workflow.**

Observed expected failure:

```text
Railway staging deploy contract failed: missing .github/workflows/railway-staging-runtime-deploy.yml
```

- [x] **Step 3: Integrate the proof into permanent Release Foundation CI and remove the temporary proof workflow.**

Permanent step:

```yaml
      - name: Prove Railway staging deployment contract
        shell: bash
        run: bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

---

### Task 2: Implement the canonical Railway workflow — GREEN

**Files:**
- Create: `.github/workflows/railway-staging-runtime-deploy.yml`

**Interfaces:**
- Consumes: GitHub Environment secret `RAILWAY_TOKEN`, variable `STAGING_RAILWAY_SERVICE`, smoke secrets `STAGING_RUNTIME_DATABASE_URL` and `STAGING_WHATSAPP_SESSION_KEY`, and the already-published canonical GHCR image.
- Produces: serialized main-only external deployment of one non-overlapping WhatsApp worker plus provider-live smoke.

- [x] **Step 1: Add main/ref/target guards.**

Required environment block:

```yaml
    environment: staging
    env:
      APP_ENV: staging
      DEPLOY_REVISION: ${{ github.sha }}
      RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
      RAILWAY_SERVICE: ${{ vars.STAGING_RAILWAY_SERVICE }}
```

Fail unless `GITHUB_REF=refs/heads/main`, `GITHUB_SHA` is 40 lowercase hex characters, the token exists, and `RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging`.

- [x] **Step 2: Pin tooling and consume the exact repository revision.**

```bash
npm install --global pnpm@11.23.0
npm install --global @railway/cli@5.45.10
pnpm install --frozen-lockfile
```

Checkout uses the repository-pinned `actions/checkout` and `actions/setup-node` commits with `persist-credentials: false`.

- [x] **Step 3: Construct, pull, and verify the immutable OCI artifact before Railway mutation.**

```bash
repository_lower="${GITHUB_REPOSITORY,,}"
echo "RUNTIME_IMAGE_GHCR=ghcr.io/${repository_lower}:sha-${GITHUB_SHA}" >> "$GITHUB_ENV"
docker pull "$RUNTIME_IMAGE_GHCR"
actual_revision="$(docker image inspect "$RUNTIME_IMAGE_GHCR" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$actual_revision" == "$GITHUB_SHA" ]]
```

- [x] **Step 4: Do not enumerate Railway variables in CI.**

`railway variable list --json` is deliberately absent because Railway returns secret values. Required variables and the forbidden `MIGRATOR_DATABASE_URL` are a provisioning/preflight contract documented in `docs/operations/railway-staging-runtime.md`; the workflow itself never accepts or injects a migrator credential.

- [x] **Step 5: Reject ambiguous/transitional topology before teardown.**

Using `railway deployment list --json`, fail if any deployment is in:

```text
BUILDING | DEPLOYING | INITIALIZING | WAITING | QUEUED | REMOVING
```

Also fail if more than one deployment is reported `SUCCESS`.

- [x] **Step 6: Stop the previous successful worker before replacement.**

```bash
railway down --service "$RAILWAY_SERVICE" --environment staging --yes
```

When a previous successful deployment exists, poll until it is `REMOVED` or absent. If it cannot be proven stopped, fail with:

```text
previous Railway deployment did not stop before replacement
```

This intentional downtime prevents old/new Baileys overlap.

- [x] **Step 7: Enforce exactly one configured replica.**

```bash
railway scale \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --json \
  us-west=0 \
  eu-west=0 \
  southeast-asia=0 \
  us-east=1
```

- [x] **Step 8: Stage the exact runtime revision without triggering an independent deployment.**

```bash
railway variable set DEPLOY_REVISION=${GITHUB_SHA} \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --skip-deploys \
  --json
```

Output is redirected to a temporary file and not printed.

- [x] **Step 9: Connect the exact immutable Docker image.**

```bash
railway service source connect \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --image "$RUNTIME_IMAGE_GHCR" \
  --json
```

If source connection itself does not create a new deployment within a short bounded check, issue:

```bash
railway redeploy --service "$RAILWAY_SERVICE" --yes --json
```

`railway up` is prohibited.

- [x] **Step 10: Poll the replacement deployment fail-closed.**

For up to five minutes, inspect the latest deployment. Require a deployment ID different from the captured baseline. Accept only `SUCCESS`; fail immediately on `FAILED`, `CRASHED`, or `REMOVED`.

- [x] **Step 11: Preserve the exact provider-live smoke contract.**

```yaml
        env:
          DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}
          WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}
          DEPLOY_REVISION: ${{ github.sha }}
```

For up to 12 attempts, run:

```bash
pnpm --silent run ops:smoke:application
```

Require:

```js
if (!report.passed) process.exit(1);
if (report.providerLiveHealth !== "HEALTHY") process.exit(1);
if (report.finalPostDeploySmokeComplete !== true) process.exit(1);
```

- [x] **Step 12: Verify GREEN in the permanent proof.**

Fresh Release Foundation CI on the implementation branch passed all three jobs, including `Prove Railway staging deployment contract`, the existing Fly contract, PostgreSQL 17.6 compatibility, operator documentation verification, controlled migration and application smoke prerequisite.

---

### Task 3: Make Railway canonical in operator documentation while preserving Fly fallback

**Files:**
- Create: `docs/operations/railway-staging-runtime.md`
- Modify: `docs/operations/environments-release.md`
- Modify: `docs/operations/release-recovery-runbook.md`
- Modify: `docs/superpowers/specs/2026-08-31-railway-staging-deploy-design.md`

**Interfaces:**
- Produces: a one-time credential ceremony, normal deploy/rollback procedure, explicit secret boundary, no-overlap worker rule, and explicit Fly fallback status.

- [x] **Step 1: Document fixed Railway target and variables.**

```text
GitHub Environment: staging
Secret: RAILWAY_TOKEN
Variable: STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging
Railway environment: staging
Railway service: pokemon-rpg-whatsapp-staging
Canonical workflow: Railway Staging Runtime Deploy
```

Document required runtime variables and forbid `MIGRATOR_DATABASE_URL`.

- [x] **Step 2: Document provider-safe non-overlapping rollout.**

Normal release explicitly stops the previous worker with `railway down`, waits for `REMOVED`, configures one replica, stages the revision, connects the exact image, waits for `SUCCESS`, and runs smoke.

- [x] **Step 3: Preserve Fly.io as inactive fallback.**

Keep `.github/workflows/staging-runtime-deploy.yml` and `fly.staging.toml` unchanged as deploy assets and retain their immutable-image, `--strategy immediate`, and one-Machine requirements in the operator docs.

- [x] **Step 4: Verify existing operator-document contract still passes.**

`pnpm ops:docs:verify` passed inside the fresh Release Foundation workflow.

---

### Task 4: Candidate review and pull-request gate

**Files:**
- Review only; no application/runtime/database schema change is expected.

- [x] **Step 1: Open draft PR from isolated branch.**

PR: `#128`, head branch `ops/railway-staging-deploy-v1`, base `main`.

- [x] **Step 2: Confirm intended file scope.**

Expected changed files are limited to:

```text
.github/workflows/railway-staging-runtime-deploy.yml
.github/workflows/release-foundation-proof.yml
db/proofs/phase17_railway_deploy_contract_e2e.sh
docs/operations/environments-release.md
docs/operations/railway-staging-runtime.md
docs/operations/release-recovery-runbook.md
docs/superpowers/plans/2026-08-31-railway-staging-deploy.md
docs/superpowers/specs/2026-08-31-railway-staging-deploy-design.md
```

- [ ] **Step 3: Require every canonical PR workflow GREEN on the final exact head.**

Do not reuse evidence from an older head after documentation or workflow edits. Fetch all workflow runs for the final exact head and require every required check to complete successfully.

- [ ] **Step 4: Final diff/security review.**

Verify no credentials, connection strings, auth blobs, secret values, application behavior changes, database migrations, or unrelated FLOW-003 work are present.

---

### Task 5: One-time external credential ceremony

**External configuration only — never commit these values.**

- [ ] **Step 1: Create a Railway project token scoped to the staging project/environment.**

The token value must never be sent to the assistant or shown in screenshots.

- [ ] **Step 2: Add the token directly to GitHub Environment `staging`.**

Secret name:

```text
RAILWAY_TOKEN
```

- [ ] **Step 3: Add/verify the non-secret GitHub Environment variable.**

```text
STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging
```

- [ ] **Step 4: Verify smoke secrets exist in GitHub Environment `staging`.**

```text
STAGING_RUNTIME_DATABASE_URL
STAGING_WHATSAPP_SESSION_KEY
```

Do not reveal their values while checking/provisioning them.

---

### Task 6: Merge gate and real external acceptance

- [ ] **Step 1: Present exact final PR head and fresh GREEN evidence to the user.**

- [ ] **Step 2: Obtain explicit merge authorization for PR #128.**

No prior approval to design/implementation counts as merge authorization.

- [ ] **Step 3: Merge with expected-head locking.**

Abort if PR head changed after authorization.

- [ ] **Step 4: Verify all post-merge canonical workflows GREEN on the exact new `main` SHA.**

- [ ] **Step 5: Verify the new immutable OCI image exists for the exact merged `main` SHA and record its digest.**

- [ ] **Step 6: Dispatch `Railway Staging Runtime Deploy` from canonical `main`.**

No browser-side manual server deployment is acceptance evidence.

- [ ] **Step 7: Require the real Railway deployment and provider-live smoke workflow to finish GREEN.**

17.3 closes only if the external Railway deploy succeeds through the merged workflow. 17.5 closes only if that workflow's exact provider-live smoke succeeds.

- [ ] **Step 8: Update Drive checklist/checkpoint only after external evidence exists.**

If both 17.3 and 17.5 close, canonical progress moves from 97.60% to 98.00%. Otherwise keep the previous canonical percentage and record the blocker/evidence precisely.
