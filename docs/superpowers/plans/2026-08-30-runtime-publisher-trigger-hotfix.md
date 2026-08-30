# Runtime Publisher Trigger Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every canonical `main` push publishes the exact immutable OCI runtime image instead of relying on a workflow that exists in the repository but did not produce a run for the current canonical merge.

**Architecture:** Keep the existing static contract proof on PRs and pushes, but make the proven-running `Runtime Image Publish Contract Proof` workflow also own the real GHCR publish job on `push` to `main`. Demote the legacy `publish-runtime-image.yml` workflow to manual-only recovery so it cannot race or duplicate publication if its external enabled state changes.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Bash contract proofs.

**Spec:** `docs/operations/environments-release.md`

## Global Constraints

- Canonical publication is restricted to `refs/heads/main`.
- Runtime image tags are `ghcr.io/<lowercase-owner/repo>:sha-<full-git-sha>` plus convenience tag `:main`.
- Published image must include SBOM and provenance attestations.
- GHCR authentication uses only the workflow-scoped `GITHUB_TOKEN` with `packages: write`.
- Publication concurrency is serialized and never cancel-in-progress.
- Pull requests must never mutate GHCR.
- The legacy publisher must not retain an automatic `push` trigger after consolidation.

---

### Task 1: Make the missing publication path a permanent RED

**Files:**
- Modify: `db/proofs/phase17_runtime_image_publish_contract_e2e.sh`
- Test: `.github/workflows/runtime-image-publish-contract-proof.yml`
- Test: `.github/workflows/publish-runtime-image.yml`

**Interfaces:**
- Consumes: the two workflow YAML files.
- Produces: a shell proof that fails unless the proven-running contract workflow contains a real push/main publisher and the legacy workflow is manual-only.

- [ ] **Step 1: Write the failing proof assertions**

Require the contract workflow to contain a `publish:` job, `packages: write`, a push/main guard, immutable SHA and `main` tags, docker-container Buildx, `--provenance=mode=max`, `--sbom=true`, `--push`, and digest verification. Require the legacy workflow to omit `push:` and retain `workflow_dispatch:`.

- [ ] **Step 2: Run the proof in CI and verify RED**

Run: `bash db/proofs/phase17_runtime_image_publish_contract_e2e.sh`

Expected: FAIL because `.github/workflows/runtime-image-publish-contract-proof.yml` does not yet contain the real publisher job.

- [ ] **Step 3: Commit the RED proof**

Commit only the proof change before production workflow changes.

### Task 2: Consolidate canonical publication into the proven-running workflow

**Files:**
- Modify: `.github/workflows/runtime-image-publish-contract-proof.yml`
- Modify: `.github/workflows/publish-runtime-image.yml`

**Interfaces:**
- Consumes: the RED contract from Task 1.
- Produces: PR-safe contract proof plus canonical main-only GHCR publication from one workflow that is already observed to run on `main` pushes.

- [ ] **Step 1: Add the minimal publisher job**

Add a `publish` job guarded by `github.event_name == 'push' && github.ref == 'refs/heads/main'`. Give the workflow `contents: read` and `packages: write`; build with the exact Dockerfile, SBOM/provenance, exact SHA tag and `main`; push once; verify both tags resolve to the same sha256 digest.

- [ ] **Step 2: Make the legacy publisher manual-only**

Remove its `push` trigger and retain `workflow_dispatch:` for explicit recovery only.

- [ ] **Step 3: Verify GREEN**

Run: `bash db/proofs/phase17_runtime_image_publish_contract_e2e.sh`

Expected: PASS.

- [ ] **Step 4: Verify all repository gates**

Require CI, Release Foundation, Runtime Image Publish Contract Proof and all normal bot proof workflows to pass on the PR head.

### Task 3: Prove actual publication after merge

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: merged canonical `main` SHA.
- Produces: real GHCR evidence for the exact SHA.

- [ ] **Step 1: Merge only with expected-head SHA protection**

- [ ] **Step 2: Verify post-merge push workflows**

Expected: all bot workflows complete successfully and `Runtime Image Publish Contract Proof` includes the real `immutable OCI runtime image` publication job.

- [ ] **Step 3: Capture the exact published digest**

Read the publication job log line `runtime image published: ghcr.io/...@sha256:...` and record the digest in the canonical checkpoint.

- [ ] **Step 4: Preserve Phase 17 boundaries**

Do not close 17.2, 17.3 or 17.5 merely because the image publisher works. Overall progress remains 97.40% until real external staging/deploy/provider evidence exists.
