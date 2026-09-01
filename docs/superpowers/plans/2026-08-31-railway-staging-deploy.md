# Railway Staging Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a canonical, reproducible Railway staging deployment path that consumes the immutable GHCR runtime image, preserves the existing Fly.io path as fallback, enforces one WhatsApp worker, and runs the existing provider-live post-deploy smoke.

**Architecture:** Keep the existing Fly.io workflow/config untouched as fallback. Add a separate Railway `workflow_dispatch` workflow driven by a project-scoped `RAILWAY_TOKEN`, a staging service variable, the exact `sha-${GITHUB_SHA}` GHCR image, a pinned Railway CLI, one-replica topology, bounded deployment polling, and the existing release-bound application smoke. Prove the workflow statically in the existing Release Foundation proof and update operator documentation so Railway is canonical staging during the zero-cost validation window.

**Tech Stack:** GitHub Actions, GHCR, Railway CLI `@railway/cli@5.45.10`, Node.js 24.19.0, pnpm 11.23.0, Bash, jq, existing TypeScript post-deploy smoke.

**Spec:** `docs/superpowers/specs/2026-08-31-railway-staging-deploy-design.md`

## Global Constraints

- GitHub remains source of truth for deploy code; Drive remains source of truth for canonical progress/checkpoints.
- Railway is the canonical staging runtime target for the current zero-cost validation window.
- Fly.io files remain present and usable as an inactive fallback; do not delete or rewrite them into Railway files.
- Routine staging deploys must not depend on browser clicks after the one-time credential ceremony.
- Deploy only from `refs/heads/main` and require a full 40-character Git SHA.
- Deploy only `ghcr.io/otiosun/sla:sha-${GITHUB_SHA}`; mutable tags such as `latest`, `main`, or `staging` are forbidden.
- Verify `org.opencontainers.image.revision == GITHUB_SHA` before any Railway mutation.
- Runtime secrets remain external. Never commit, print, or request the value of `RAILWAY_TOKEN`, `DATABASE_URL`, `WHATSAPP_AUTH_KEY_BASE64`, or other credentials.
- Railway runtime must contain `DATABASE_URL`, `WHATSAPP_SESSION_KEY`, `WHATSAPP_AUTH_KEY_BASE64`, and `WHATSAPP_AUTH_KEY_VERSION`; it must not contain `MIGRATOR_DATABASE_URL`.
- One WhatsApp session maps to one active worker. Canonical staging topology must total exactly one replica.
- `DEPLOY_REVISION` on Railway must equal the exact deployed Git SHA.
- A Railway deployment is not GREEN until it reaches `SUCCESS` and the exact provider-live smoke returns `passed === true`, `providerLiveHealth === "HEALTHY"`, and `finalPostDeploySmokeComplete === true`.
- No automatic merge. Merge requires explicit user authorization against the exact PR head SHA.
- 17.3 and 17.5 remain open until the merged workflow performs a real external deployment and smoke successfully.

---

### Task 1: Railway deploy contract proof — RED

**Files:**
- Create: `db/proofs/phase17_railway_deploy_contract_e2e.sh`
- Modify: `.github/workflows/release-foundation-proof.yml`

**Interfaces:**
- Consumes: repository workflow/docs as plain text.
- Produces: one permanent fail-closed proof command, `bash db/proofs/phase17_railway_deploy_contract_e2e.sh`.

- [ ] **Step 1: Write the failing contract proof**

Create `db/proofs/phase17_railway_deploy_contract_e2e.sh` using the same `require_literal`/`reject_literal` pattern as `phase17_fly_deploy_contract_e2e.sh`.

The proof must require these workflow literals:

```bash
workflow=".github/workflows/railway-staging-runtime-deploy.yml"
fly_workflow=".github/workflows/staging-runtime-deploy.yml"
fly_config="fly.staging.toml"
environments_doc="docs/operations/environments-release.md"
recovery_doc="docs/operations/release-recovery-runbook.md"

require_literal "$workflow" 'workflow_dispatch:'
require_literal "$workflow" 'environment: staging'
require_literal "$workflow" 'refs/heads/main'
require_literal "$workflow" 'cancel-in-progress: false'
require_literal "$workflow" 'RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}'
require_literal "$workflow" 'RAILWAY_SERVICE: ${{ vars.STAGING_RAILWAY_SERVICE }}'
require_literal "$workflow" 'npm install --global @railway/cli@5.45.10'
require_literal "$workflow" 'RUNTIME_IMAGE_GHCR=ghcr.io/${repository_lower}:sha-${GITHUB_SHA}'
require_literal "$workflow" 'org.opencontainers.image.revision'
require_literal "$workflow" 'railway variable list'
require_literal "$workflow" 'MIGRATOR_DATABASE_URL'
require_literal "$workflow" 'railway variable set DEPLOY_REVISION=${GITHUB_SHA}'
require_literal "$workflow" '--skip-deploys'
require_literal "$workflow" 'railway service source connect'
require_literal "$workflow" '--image "$RUNTIME_IMAGE_GHCR"'
require_literal "$workflow" 'us-east=1'
require_literal "$workflow" 'us-west=0'
require_literal "$workflow" 'eu-west=0'
require_literal "$workflow" 'southeast-asia=0'
require_literal "$workflow" 'railway deployment list'
require_literal "$workflow" 'SUCCESS'
require_literal "$workflow" 'FAILED|CRASHED|REMOVED'
require_literal "$workflow" 'pnpm --silent run ops:smoke:application'
require_literal "$workflow" 'providerLiveHealth'
require_literal "$workflow" 'finalPostDeploySmokeComplete'
reject_literal "$workflow" ':latest'
reject_literal "$workflow" ':main'
reject_literal "$workflow" ':staging'
reject_literal "$workflow" 'MIGRATOR_DATABASE_URL:'

[[ -f "$fly_workflow" ]] || fail "Fly fallback workflow was removed"
[[ -f "$fly_config" ]] || fail "Fly fallback config was removed"
```

The proof must also require operator docs to state Railway is canonical staging and Fly is fallback.

- [ ] **Step 2: Wire the proof into Release Foundation CI**

Add immediately after the existing Fly contract proof:

```yaml
      - name: Prove Railway staging deployment contract
        shell: bash
        run: bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

- [ ] **Step 3: Run the focused proof and verify RED**

Run:

```bash
bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

Expected: FAIL because `.github/workflows/railway-staging-runtime-deploy.yml` does not exist yet.

- [ ] **Step 4: Commit the RED proof**

```bash
git add db/proofs/phase17_railway_deploy_contract_e2e.sh .github/workflows/release-foundation-proof.yml
git commit -m "test: define Railway staging deploy contract"
```

---

### Task 2: Canonical Railway workflow — GREEN

**Files:**
- Create: `.github/workflows/railway-staging-runtime-deploy.yml`

**Interfaces:**
- Consumes: `RAILWAY_TOKEN` GitHub Environment secret, `STAGING_RAILWAY_SERVICE` GitHub Environment variable, `STAGING_RUNTIME_DATABASE_URL`, `STAGING_WHATSAPP_SESSION_KEY`, canonical GHCR image.
- Produces: serialized main-only Railway deploy with exact SHA, one replica, bounded terminal-state polling, and exact provider-live smoke.

- [ ] **Step 1: Create workflow header and fail-closed target validation**

Use:

```yaml
name: Railway Staging Runtime Deploy

on:
  workflow_dispatch:

permissions:
  contents: read
  packages: read

concurrency:
  group: railway-staging-runtime-deploy
  cancel-in-progress: false

jobs:
  deploy:
    name: immutable Railway staging worker
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment: staging
    env:
      APP_ENV: staging
      DEPLOY_REVISION: ${{ github.sha }}
      RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
      RAILWAY_SERVICE: ${{ vars.STAGING_RAILWAY_SERVICE }}
```

The first shell step must require:

```bash
set -euo pipefail
[[ "$GITHUB_REF" == "refs/heads/main" ]] || exit 64
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 64
[[ -n "$RAILWAY_TOKEN" ]] || exit 64
[[ "$RAILWAY_SERVICE" == "pokemon-rpg-whatsapp-staging" ]] || exit 64
```

- [ ] **Step 2: Reuse exact checkout/runtime tooling and pin Railway CLI**

Use the repository's pinned actions and versions:

```yaml
      - name: Checkout exact revision
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version-file: .node-version
          package-manager-cache: false

      - name: Install exact pnpm and Railway CLI
        run: |
          npm install --global pnpm@11.23.0
          npm install --global @railway/cli@5.45.10

      - name: Install dependencies from lockfile
        run: pnpm install --frozen-lockfile
```

- [ ] **Step 3: Construct and verify immutable GHCR image before Railway mutation**

Use:

```bash
repository_lower="${GITHUB_REPOSITORY,,}"
echo "RUNTIME_IMAGE_GHCR=ghcr.io/${repository_lower}:sha-${GITHUB_SHA}" >> "$GITHUB_ENV"
```

Then log into GHCR using `${{ secrets.GITHUB_TOKEN }}`, pull the image, and verify:

```bash
actual_revision="$(docker image inspect "$RUNTIME_IMAGE_GHCR" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$actual_revision" == "$GITHUB_SHA" ]]
```

- [ ] **Step 4: Verify runtime secret-name boundary without printing values**

Use the Railway project token context and pipe JSON directly to `jq` so values are never echoed:

```bash
variable_names="$(railway variable list --service "$RAILWAY_SERVICE" --environment staging --json | jq -r 'keys[]')"
for required_secret in DATABASE_URL WHATSAPP_SESSION_KEY WHATSAPP_AUTH_KEY_BASE64 WHATSAPP_AUTH_KEY_VERSION; do
  grep -Fxq "$required_secret" <<<"$variable_names" || exit 1
done
if grep -Fxq "MIGRATOR_DATABASE_URL" <<<"$variable_names"; then
  exit 1
fi
```

Do not enable shell tracing (`set -x`).

- [ ] **Step 5: Enforce the one-worker topology before source mutation**

Use the four currently documented Railway regions so the resulting total is exactly one replica:

```bash
railway scale \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --json \
  us-west=0 \
  eu-west=0 \
  southeast-asia=0 \
  us-east=1 >/tmp/railway-scale.json
```

Do not print `/tmp/railway-scale.json` unless diagnosing non-secret topology output.

- [ ] **Step 6: Stage exact deployment revision without triggering a deployment**

Use:

```bash
railway variable set DEPLOY_REVISION=${GITHUB_SHA} \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --skip-deploys \
  --json >/tmp/railway-variable-set.json
```

- [ ] **Step 7: Capture baseline deployment and connect the exact immutable image**

Before source mutation:

```bash
before_id="$(railway deployment list --service "$RAILWAY_SERVICE" --environment staging --limit 1 --json | jq -r '.[0].id // empty')"
```

Then connect the exact image:

```bash
railway service source connect \
  --service "$RAILWAY_SERVICE" \
  --environment staging \
  --image "$RUNTIME_IMAGE_GHCR" \
  --json >/tmp/railway-source-connect.json
```

The workflow must not call `railway up`; Railway must consume the already-built OCI image rather than upload/rebuild source.

- [ ] **Step 8: Wait for a new terminal deployment and fail closed**

Poll for at most 5 minutes:

```bash
deployment_id=""
for attempt in {1..60}; do
  deployment_json="$(railway deployment list --service "$RAILWAY_SERVICE" --environment staging --limit 1 --json)"
  current_id="$(jq -r '.[0].id // empty' <<<"$deployment_json")"
  current_status="$(jq -r '.[0].status // empty' <<<"$deployment_json")"

  if [[ -n "$current_id" && "$current_id" != "$before_id" ]]; then
    deployment_id="$current_id"
    case "$current_status" in
      SUCCESS) break ;;
      FAILED|CRASHED|REMOVED)
        echo "Railway deployment ${current_id} ended in ${current_status}" >&2
        exit 1
        ;;
    esac
  fi

  [[ "$attempt" -lt 60 ]] || {
    echo "Railway deployment did not reach SUCCESS in time" >&2
    exit 1
  }
  sleep 5
done

echo "Railway deployment ${deployment_id} reached SUCCESS for ${GITHUB_SHA}"
```

- [ ] **Step 9: Preserve the existing provider-live smoke contract**

Use the same bounded smoke logic as the Fly workflow with:

```yaml
        env:
          DATABASE_URL: ${{ secrets.STAGING_RUNTIME_DATABASE_URL }}
          WHATSAPP_SESSION_KEY: ${{ secrets.STAGING_WHATSAPP_SESSION_KEY }}
          DEPLOY_REVISION: ${{ github.sha }}
```

Require all three predicates:

```js
if (!report.passed) process.exit(1);
if (report.providerLiveHealth !== "HEALTHY") process.exit(1);
if (report.finalPostDeploySmokeComplete !== true) process.exit(1);
```

- [ ] **Step 10: Clean up GHCR authentication**

```bash
docker logout ghcr.io >/dev/null 2>&1 || true
```

- [ ] **Step 11: Run the Railway contract proof and verify GREEN**

```bash
bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

Expected: PASS.

- [ ] **Step 12: Commit the workflow**

```bash
git add .github/workflows/railway-staging-runtime-deploy.yml
git commit -m "ci: add Railway staging runtime deploy"
```

---

### Task 3: Make operator documentation canonical for Railway while preserving Fly fallback

**Files:**
- Create: `docs/operations/railway-staging-runtime.md`
- Modify: `docs/operations/environments-release.md`
- Modify: `docs/operations/release-recovery-runbook.md`
- Modify: `db/proofs/phase17_railway_deploy_contract_e2e.sh`

**Interfaces:**
- Produces: one-time Railway credential ceremony, normal dispatch procedure, failure/rollback boundaries, and explicit Fly fallback status.

- [ ] **Step 1: Add Railway staging runtime runbook**

Document exactly:

```text
GitHub Environment: staging
Required secret: RAILWAY_TOKEN
Required variable: STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging
Railway environment: staging
Railway service: pokemon-rpg-whatsapp-staging
Required runtime variables: DATABASE_URL, WHATSAPP_SESSION_KEY, WHATSAPP_AUTH_KEY_BASE64, WHATSAPP_AUTH_KEY_VERSION, APP_ENV, DEPLOY_REVISION, LOG_LEVEL, WHATSAPP_HEALTH_HEARTBEAT_MS
Forbidden runtime variable: MIGRATOR_DATABASE_URL
Canonical workflow: Railway Staging Runtime Deploy
Fallback only: Fly.io Staging Runtime Deploy
```

State that the project token is created in Railway for the staging project/environment and is pasted directly into GitHub Environment `staging` as `RAILWAY_TOKEN`; it is never pasted into chat, Git, docs, screenshots, or logs.

- [ ] **Step 2: Update `environments-release.md`**

Replace statements that Fly is the approved/canonical Phase 17 staging target with Railway as canonical zero-cost staging. Preserve the existing Fly section under an explicit `Fly.io fallback` heading and do not weaken any one-worker, immutable-image, runtime-secret, or provider-live requirements.

The release order must dispatch `Railway Staging Runtime Deploy` as the normal staging path.

- [ ] **Step 3: Update `release-recovery-runbook.md`**

Change global stop rules from "more than one active Fly Machine" to provider-neutral wording: more than one active runtime worker using the same Baileys session is forbidden.

For staging A7/A8, document Railway as canonical:

```text
GHCR exact image -> Railway service source -> one replica -> terminal SUCCESS -> provider-live smoke
```

Keep Fly commands in a clearly marked fallback/incident section instead of deleting them.

Rollback must never reset WhatsApp auth or database state. A code-only rollback uses a previously known-good immutable image only when schema compatibility is proven.

- [ ] **Step 4: Extend the Railway contract proof for docs**

Require literals proving:

```bash
require_literal "$environments_doc" 'Railway'
require_literal "$environments_doc" 'Fly.io fallback'
require_literal "$recovery_doc" 'Railway'
require_literal "$recovery_doc" 'one active runtime worker'
```

Also require `docs/operations/railway-staging-runtime.md` exists and contains `RAILWAY_TOKEN`, `STAGING_RAILWAY_SERVICE`, `MIGRATOR_DATABASE_URL`, and `provider-live`.

- [ ] **Step 5: Run both deployment contract proofs**

```bash
bash db/proofs/phase17_fly_deploy_contract_e2e.sh
bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

Expected: both PASS. Railway becoming canonical must not break the preserved Fly fallback proof.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/operations/railway-staging-runtime.md docs/operations/environments-release.md docs/operations/release-recovery-runbook.md db/proofs/phase17_railway_deploy_contract_e2e.sh
git commit -m "docs: make Railway canonical staging target"
```

---

### Task 4: Repository-wide verification and PR

**Files:**
- Review only: all branch changes against current `main`.

**Interfaces:**
- Produces: reviewable PR with exact head SHA and no external deployment yet.

- [ ] **Step 1: Run focused static deploy proofs**

```bash
bash db/proofs/phase17_fly_deploy_contract_e2e.sh
bash db/proofs/phase17_railway_deploy_contract_e2e.sh
```

Expected: PASS / PASS.

- [ ] **Step 2: Run repository quality gates**

```bash
pnpm format:check
pnpm typecheck
pnpm test
```

Expected: all exit 0.

- [ ] **Step 3: Run operator documentation verifier**

```bash
pnpm ops:docs:verify
```

Expected: exit 0.

- [ ] **Step 4: Review the exact diff for secrets and scope**

Confirm no literal credentials, database URLs, auth blobs, Railway tokens, or unrelated FLOW/PVP changes exist.

Expected changed scope:

```text
.github/workflows/railway-staging-runtime-deploy.yml
.github/workflows/release-foundation-proof.yml
db/proofs/phase17_railway_deploy_contract_e2e.sh
docs/operations/railway-staging-runtime.md
docs/operations/environments-release.md
docs/operations/release-recovery-runbook.md
docs/superpowers/specs/2026-08-31-railway-staging-deploy-design.md
docs/superpowers/plans/2026-08-31-railway-staging-deploy.md
```

- [ ] **Step 5: Open a draft PR against `main`**

Title:

```text
ci: add canonical Railway staging deploy
```

PR body must state:

```text
- Railway is canonical staging for the zero-cost validation window.
- Fly.io remains preserved as fallback.
- No external deploy has been executed by this PR.
- 17.3/17.5 remain open until post-merge real deploy + provider-live smoke.
- Manual setup still required once: RAILWAY_TOKEN secret and STAGING_RAILWAY_SERVICE variable in GitHub Environment staging.
```

- [ ] **Step 6: Require every canonical PR check GREEN on the exact head SHA**

Do not merge on stale checks or on a different head.

---

### Task 5: One-time credential ceremony and real acceptance deploy

**Files:**
- External configuration only; no repository secret values.

**Interfaces:**
- Consumes: merged canonical workflow and user-created Railway project token.
- Produces: real external evidence eligible to close Phase 17.3 and 17.5.

- [ ] **Step 1: After explicit merge authorization, merge with expected-head lock and revalidate canonical main**

Record exact merge/main SHA. Wait for the canonical OCI `sha-<main-sha>` image publication to succeed before dispatching Railway.

- [ ] **Step 2: User creates one Railway project token**

In Railway project settings, create a project token scoped to the prepared staging project/environment. Do not expose the token in chat.

- [ ] **Step 3: User adds GitHub Environment configuration directly**

In repository Settings -> Environments -> `staging`:

```text
Secret:
RAILWAY_TOKEN=<paste directly from Railway>

Variable:
STAGING_RAILWAY_SERVICE=pokemon-rpg-whatsapp-staging
```

Existing `STAGING_RUNTIME_DATABASE_URL` and `STAGING_WHATSAPP_SESSION_KEY` must remain available for smoke.

- [ ] **Step 4: Dispatch `Railway Staging Runtime Deploy` from `main`**

No manual Railway Deploy click is part of the canonical execution.

- [ ] **Step 5: Require workflow SUCCESS on the exact canonical main SHA**

Evidence must show:

```text
OCI revision verified
runtime secret-name boundary passed
one-replica topology enforced
new Railway deployment reached SUCCESS
provider-live smoke passed
```

- [ ] **Step 6: Close Phase gates only with real evidence**

If the workflow is successful and exact provider-live smoke passes:

```text
17.3 -> complete (97.80%)
17.5 -> complete (98.00%)
```

If any external step fails, keep both items open and diagnose without resetting the WhatsApp session/database or exposing secrets.
