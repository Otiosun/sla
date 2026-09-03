# Control Center Core Local Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frozen Control Center Core runnable on a developer Windows machine with the real Admin API and PostgreSQL, without requiring Cloudflare Access and without weakening staging/production authentication.

**Architecture:** Add a development-only local administrative identity boundary selected only by explicit configuration. It must be rejected unless APP_ENV=development, ADMIN_API_HOST is loopback, and ADMIN_API_ALLOWED_ORIGIN is a localhost/127.0.0.1 origin. The local boundary uses a configured UUID principal that already exists in PostgreSQL; normal Cloudflare Access remains unchanged for every non-local mode. Frontend stays a normal API consumer at http://localhost:8787.

**Tech Stack:** Node 24.19.0, pnpm 11.23.0, TypeScript 7, Fastify 5, PostgreSQL, Zod, Vitest, React/Vite frontend.

**Spec:** Google Drive `CONTROL CENTER CORE — ESCOPO CANÔNICO V1 — 2026-09-03` (ID `1Cibr-ne5Qr5frTVlvbKhkpYYnMJFfqhwnfN-1rU7Zyg`).

## Global Constraints

- Never modify the frozen archive branches; implementation uses dedicated local-run prep branches.
- Never enable local auth in staging or production.
- Local auth must require loopback API host and loopback browser origin.
- No client-supplied roles/capabilities/scopes/environment.
- The configured local principal must be resolved from PostgreSQL and must be ACTIVE.
- HTTP remains READ + PREPARE ONLY; local mode does not expose simulate/confirm/approve/apply.
- No secrets or database passwords are committed.
- Do not merge to main or deploy production.

---

### Task 1: Local-auth configuration boundary

**Files:**
- Modify: `src/platform/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Produces `adminLocalDevPrincipalId: string | null` on `AppConfig`.
- Local mode is active only when `ADMIN_LOCAL_DEV_PRINCIPAL_ID` is set.

- [ ] Write RED tests proving development+127.0.0.1+localhost origin is accepted and staging/production/non-loopback combinations are rejected.
- [ ] Run the config tests and preserve the expected RED.
- [ ] Implement the minimal Zod/config validation.
- [ ] Run targeted tests and full typecheck.

### Task 2: Development-only authenticator/session boundary

**Files:**
- Create: `src/adapters/admin-api/local-dev-authenticator.ts`
- Create: `tests/admin/local-dev-authenticator.test.ts`
- Modify: `src/runtime/compose-admin-api.ts`

**Interfaces:**
- Local authenticator returns the same trusted request context shape as Cloudflare authentication.
- It resolves the configured principal from PostgreSQL; roles/capabilities/scopes are still loaded by existing services.
- Local session authorization is process-local and development-only; it does not write fake Cloudflare fingerprints to durable Access-session tables.

- [ ] Write RED for ACTIVE principal success and missing/DISABLED principal denial.
- [ ] Write RED for runtime composition selecting local boundary only when config is explicitly local.
- [ ] Run RED.
- [ ] Implement minimal local boundary.
- [ ] Run admin/security tests and full CI.

### Task 3: Safe local admin bootstrap

**Files:**
- Create: `scripts/operations/bootstrap-local-admin.ts`
- Create: `src/operations/local-admin-bootstrap-config.ts`
- Create: `tests/admin/local-admin-bootstrap.test.ts`
- Modify: `package.json`

**Interfaces:**
- Command prints the generated/reused local principal UUID.
- It may run only with APP_ENV=development and a loopback PostgreSQL target.
- It grants `OWNER_SECURITY_ADMIN` + one GLOBAL scope through the canonical registry seed.

- [ ] RED: non-development and non-loopback DB are rejected.
- [ ] RED: fresh local DB gets one ACTIVE local principal with OWNER_SECURITY_ADMIN and GLOBAL scope; rerun is idempotent.
- [ ] Implement minimal bootstrap.
- [ ] Run PostgreSQL test and full CI.

### Task 4: One-command local runbook

**Files:**
- Create: `docs/operator/control-center-core-local.md`
- Update: `.env.example`

**Interfaces:**
- Exact Windows PowerShell commands for PostgreSQL prerequisite, migration, Phase 12 registry, local admin bootstrap, Admin API, and frontend.
- No hidden credentials; placeholders are explicit.

- [ ] Document exact environment variables and startup order.
- [ ] Document expected URLs (`http://127.0.0.1:8787`, frontend Vite URL).
- [ ] Document smoke checks and stop commands.
- [ ] Run operator-doc verification if applicable and full CI.

### Task 5: Frontend local-run handoff

**Files (frontend repo):**
- Update: `control-center/README.md`
- Create: `control-center/LOCAL_RUN.md`

**Interfaces:**
- Uses existing `.env.example`: development + API base `http://localhost:8787`.
- Uses existing `pnpm dev`; no frontend auth bypass.

- [ ] Add exact Node/pnpm/install/materialize-lock commands.
- [ ] Link backend local runbook and explicitly state browser never supplies authority.
- [ ] Run Control Center verify and performance budget.
