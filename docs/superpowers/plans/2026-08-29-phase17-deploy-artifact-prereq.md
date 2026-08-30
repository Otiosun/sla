# Phase 17 Deploy Artifact Prerequisite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a provider-neutral OCI runtime artifact for the Pokémon WhatsApp bot and permanently prove that it is deployable, production-minimal, non-root, fail-closed, and compatible with the repository's PostgreSQL support floor without falsely closing Phase 17.3.

**Architecture:** Compile TypeScript to JavaScript before the runtime stage; install only production dependencies in the final image; explicitly copy the hand-written Baileys JS bridge and migrations into the paths used by compiled `import.meta.url` resolution. Keep migrations outside runtime startup. Exercise the artifact through the existing Release Foundation workflow so proof runs before this new workflow concern exists on `main`.

**Tech Stack:** Node.js 24.19.0, pnpm 11.23.0, TypeScript 7.0.2, Docker/OCI, GitHub Actions, PostgreSQL 17/18.

**Spec:** Drive canonical Phase 17 checklist/checkpoint plus `docs/operations/environments-release.md` and `docs/operations/release-recovery-runbook.md`.

## Global Constraints

- GitHub is source of truth for code; Drive is source of truth for decisions/checkpoints.
- Runtime and migrator credentials remain distinct in staging/production.
- No secret, `.env`, WhatsApp auth key, or provider credential may be baked into the image.
- Runtime container must not run migrations as a startup side effect.
- Runtime must run as a non-root user.
- Production image must not require `tsx`, TypeScript, Vitest, Biome, or other devDependencies.
- Compiled runtime must include `dist/src/adapters/whatsapp/baileys-runtime.js` and `dist/db/migrations/*.sql`.
- `17.3` remains open until a real external deploy target/CI-CD path exists; this prerequisite alone changes global progress by 0.00%.

---

### Task 1: Permanent failing artifact proof

**Files:**
- Create: `db/proofs/phase17_deploy_artifact_e2e.sh`
- Modify: `.github/workflows/release-foundation-proof.yml`

**Interfaces:**
- Consumes: Docker CLI on GitHub-hosted runner and repository root as build context.
- Produces: an executable proof that builds and inspects `pokemon-rpg-runtime:proof` and fails if artifact invariants are absent.

- [ ] **Step 1: Write the failing proof**

The proof must build the repository Dockerfile, inspect `Config.User`, `Config.Cmd`, `NODE_ENV`, runtime dependency availability, required compiled assets, forbidden source/test/secret paths, and fail-closed startup without `DATABASE_URL`.

- [ ] **Step 2: Wire proof into the existing recognized Release Foundation workflow**

Add a separate `deploy-artifact-proof` job with checkout and `bash db/proofs/phase17_deploy_artifact_e2e.sh`.

- [ ] **Step 3: Push and verify RED**

Expected: the new job fails because `Dockerfile` does not yet exist. Existing jobs must remain unaffected.

### Task 2: Compiled production artifact

**Files:**
- Create: `tsconfig.build.json`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `src/**/*.ts`, `src/adapters/whatsapp/baileys-runtime.js`, `db/migrations/*.sql`, `package.json`, `pnpm-lock.yaml`.
- Produces: `pnpm build` and an OCI image whose command is `node dist/src/main.js`.

- [ ] **Step 1: Add build configuration**

Compile only production TypeScript sources and operational CLI sources needed inside the artifact; do not emit tests.

- [ ] **Step 2: Add deterministic build script**

`package.json` gains `build` and production runtime scripts that do not invoke `tsx`.

- [ ] **Step 3: Build multi-stage image**

Use exact Node 24.19.0 tag, Corepack/pnpm 11.23.0, frozen lockfile, production dependency stage, non-root final user, `NODE_ENV=production`, exec-form `CMD`, and no automatic migration command.

- [ ] **Step 4: Copy non-TypeScript runtime assets explicitly**

Copy `src/adapters/whatsapp/baileys-runtime.js` to `dist/src/adapters/whatsapp/baileys-runtime.js` and `db/migrations` to `dist/db/migrations`.

- [ ] **Step 5: Run proof and verify GREEN**

Expected: deploy-artifact proof passes; generic formatter/typecheck/tests remain green.

### Task 3: PostgreSQL version-floor proof

**Files:**
- Modify: `.github/workflows/release-foundation-proof.yml`
- Modify: `README.md` only if support wording must distinguish CI baseline from staging floor.

**Interfaces:**
- Consumes: current migrations and DB proof commands.
- Produces: release-foundation coverage against PostgreSQL 17 and 18 without modifying the external Supabase project.

- [ ] **Step 1: Add PostgreSQL 17 compatibility leg**

Run migration/schema/runtime-grant verification against PG17 in CI using the same release foundation sequence where practical.

- [ ] **Step 2: Preserve PG18 canonical leg**

Do not weaken or replace existing PG18.6 coverage.

- [ ] **Step 3: Verify both legs**

Expected: schema/migration/release proof passes on PG17 and PG18.

### Task 4: WIP proof, clean promotion, and documentation sync

**Files:**
- No new implementation files.

**Interfaces:**
- Consumes: final WIP tree.
- Produces: clean exact-tree one-commit candidate, PR evidence, expected-head merge, post-merge workflow evidence, and Drive milestone.

- [ ] **Step 1: Audit WIP diff against canonical main**

Confirm only intended files changed and no secret/material external staging mutation occurred.

- [ ] **Step 2: Require full canonical checks**

All recognized push/pull-request workflows must be green; known flakes only count after exact-SHA rerun success with evidence.

- [ ] **Step 3: Create clean exact-tree one-commit candidate**

Create a tree identical to the proven WIP tree with parent equal to the then-current canonical `main`.

- [ ] **Step 4: Merge with expected head and verify post-merge**

Do not deploy externally in this milestone.

- [ ] **Step 5: Sync Drive with revision lock**

Record evidence and explicitly keep `17.3 □`, `17.2 □`, and `17.5 □` open unless separate real-target proof exists.
