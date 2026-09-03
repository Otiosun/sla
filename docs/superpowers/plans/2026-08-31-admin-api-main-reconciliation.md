# Admin API Main Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebase the proven Pokémon Control Center Admin API slice onto the current `main` without losing the newer WhatsApp/runtime/staging work or weakening administrative security gates.

**Architecture:** Start from current `main` `5e1ef6c1241fcfbdc6e618b5a3c58cbeb0a74cd3` and transplant the final state of PR #89 rather than merging its stale history. Preserve current runtime files by default. Resolve only overlapping files explicitly. Renumber the two unmerged Admin API migrations after current `0026_runtime_health_evidence.sql`, keep migration history immutable, and rerun canonical CI/proofs before opening a replacement integration PR.

**Tech Stack:** Node 24.19.0, TypeScript 7.0.2 strict, pnpm 11.23.0, PostgreSQL 17/18 compatibility proofs, Fastify 5.12.1, Vitest 4.1.11, GitHub Actions.

**Spec:** `docs/security/admin-control-plane-boundary.md`, `docs/security/admin-authentication-protocol.md`, `docs/security/admin-api-csrf-protection.md`, Control Center checkpoint in Drive.

## Global Constraints

- `main` is not modified directly.
- Preserve all current Phase 17 WhatsApp/runtime/staging changes from `main`.
- No HTTP mutation lifecycle beyond `prepare`.
- No SQL/JS/PATCH generic admin bypass.
- Browser never supplies principal, environment, roles, capabilities, scopes, or correlation ID as authority.
- Existing applied migration files are immutable.
- Admin API migrations from stale PR #89 are not canonical and may be renumbered before merge.
- Frozen lockfile and patched Baileys rc14 dependency must remain valid.

---

### Task 1: Prove and encode the migration collision

**Files:**
- Create: `tests/db/admin-api-main-reconciliation.test.ts`
- Preserve: `db/migrations/0026_runtime_health_evidence.sql`
- Later create: `db/migrations/0027_admin_api_rate_limit_buckets.sql`
- Later create: `db/migrations/0028_admin_api_mutation_prepare_rate_limit.sql`

- [ ] Add a contract test that asserts the current runtime migration remains `0026` and Admin API migrations occupy unique later versions.
- [ ] Run the targeted test and confirm RED before transplanting/renumbering Admin API migrations.
- [ ] Transplant the two Admin API migrations as 0027/0028 and update all Admin API proof references.
- [ ] Run the targeted test and migration/recovery proofs to GREEN.

### Task 2: Transplant non-conflicting Admin API slice

**Files:**
- Add Admin API adapters, runtime composition, identity/rate-limit repositories, security docs, Admin API tests and the Admin mutation correlation E2E from PR #89.
- Modify `.github/workflows/admin-proof.yml` only by carrying the Admin API proof steps onto the current workflow.

- [ ] Copy exact final blobs from PR #89 for files absent from current `main`.
- [ ] Preserve current `main` versions for unrelated runtime/staging files.
- [ ] Verify diff contains only Admin API scope plus reconciliation test/docs.

### Task 3: Reconcile overlapping application/config files

**Files:**
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/main.ts`
- Modify: `src/platform/config/env.ts`
- Modify: `db/proofs/phase16_recovery_migration_e2e.ts`
- Modify: `db/proofs/phase17_postgres17_release_compatibility.sh`

- [ ] Preserve all current WhatsApp/runtime/staging settings and bootstrap scripts.
- [ ] Add Fastify/Admin API config and composition without reverting Phase 17 changes.
- [ ] Preserve patched Baileys rc14 plus `qrcode-terminal`; add Fastify 5.12.1 to the same frozen lockfile.
- [ ] Make migration proofs derive current migration count rather than hard-code stale counts where already required by the PR #89 fix.

### Task 4: Fresh verification

- [ ] Run canonical CI on the integration head.
- [ ] Run Admin Proof and Security Integrity Proof.
- [ ] Run WhatsApp, Release, migration/rollback, PostgreSQL compatibility, performance, and domain proofs triggered by the branch.
- [ ] Confirm zero pending/failing canonical checks before claiming reconciliation complete.

### Task 5: Replacement PR and documentation

- [ ] Open a new DRAFT PR from `integration/admin-api-main-2026-08-31` to `main` only after fresh verification.
- [ ] Mark stale PR #89 as superseded only after the replacement PR preserves its behavior and evidence.
- [ ] Update Drive Control Center checkpoint with new head, migration numbering, test evidence, remaining F2/F4 gaps, and unchanged Control Center percentage unless a checklist DoD is newly satisfied.
