# Phase 17 Runtime Health + Fly Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the long-running WhatsApp runtime externally deployable to Fly.io and produce durable, revision-bound provider health evidence that can close Phase 17.5 only after a real deployment.

**Architecture:** Keep the runtime as a single non-HTTP worker. Persist one runtime-instance identity per process plus mutable lifecycle timestamps/state in PostgreSQL, fed by provider-neutral connection callbacks from the WhatsApp adapter. Extend the existing Phase 17 smoke to require a matching connected instance and fresh heartbeat. Add a Fly.io staging deployment contract that consumes the immutable GHCR artifact, but do not mark 17.3/17.5 complete until real Fly deployment/provider evidence exists.

**Tech Stack:** Node.js 24.19.0, TypeScript 7.0.2, pnpm 11.23.0, PostgreSQL 17/18, Baileys 7.0.0-rc14, GitHub Actions, GHCR, Fly.io Machines.

**Spec:** Drive canonical Phase 17 checklist/checkpoint plus approved 2026-08-30 runtime target decision: Fly.io `gru`, one always-on `shared-cpu-1x` 512 MB worker, no public HTTP service, PostgreSQL-backed operational health evidence.

## Global Constraints

- GitHub is source of truth for code; Drive is source of truth for decisions/checkpoints.
- Never edit migrations 0001–0025; new schema is migration 0026.
- One WhatsApp session maps to one active worker in v1; no active-active replica.
- No HTTP health endpoint is introduced solely for the deploy platform.
- No persistent Fly volume is required; durable state remains in PostgreSQL.
- Runtime must not run migrations automatically at startup.
- Runtime health evidence must be bound to exact full Git SHA, environment and WhatsApp session key.
- A stale heartbeat, disconnected state, wrong revision, wrong session or missing runtime instance must fail the final smoke.
- Runtime credentials receive only the minimum INSERT/UPDATE/SELECT privileges required for operational evidence; no DELETE.
- Fly deployment consumes an immutable GHCR SHA artifact, uses region `gru`, one Machine, 512 MB, and an always-restart/no-autostop policy.
- `17.3` and `17.5` remain open until real external deployment/provider evidence exists. Preparatory code changes carry 0.00pp by themselves.

---

### Task 1: Provider connection-state contract — RED → GREEN

**Files:**
- Modify: `tests/messaging/baileys-provider.test.ts`
- Modify: `src/adapters/whatsapp/adapter.ts`
- Modify: `src/adapters/whatsapp/baileys-whatsapp-adapter.ts`

**Interfaces:**
- Produces: `WhatsAppProviderConnectionState = "CONNECTED" | "DISCONNECTED"` and an optional adapter callback receiving state transitions.

- [ ] Write failing tests proving `connection.update=open` emits CONNECTED and `close` emits DISCONNECTED before reconnect/logout handling.
- [ ] Run focused test and verify RED because the callback contract does not exist.
- [ ] Implement the minimal provider-neutral callback contract.
- [ ] Run focused tests and verify GREEN, including existing reconnect/logout cases.

### Task 2: Durable runtime-instance evidence — RED → GREEN

**Files:**
- Create: `db/migrations/0026_runtime_health_evidence.sql`
- Create: `src/runtime/postgres-runtime-health.ts`
- Create: `db/proofs/phase17_runtime_health_e2e.ts`
- Modify: `db/bootstrap/runtime_grants.sql`
- Modify: `.github/workflows/release-foundation-proof.yml`
- Modify: `db/proofs/phase16_recovery_migration_e2e.ts`

**Interfaces:**
- Produces runtime-instance registration, provider-state transitions, heartbeat updates and shutdown evidence keyed by UUID and exact deployment SHA.

- [ ] Write PostgreSQL proof first for insert, connected transition, heartbeat, disconnect, stop, validation, no DELETE privilege and historical-row preservation.
- [ ] Wire proof into a permanent release proof and verify RED.
- [ ] Add migration 0026 with fail-closed checks for environment, SHA, session key and provider state.
- [ ] Add least-privilege runtime grants for SELECT/INSERT/UPDATE only.
- [ ] Implement repository methods for register, connected/disconnected, heartbeat and terminal state.
- [ ] Update forward-migration proof from 0025 → 0026.
- [ ] Verify GREEN on PostgreSQL 17 and canonical PostgreSQL 18 proof paths.

### Task 3: Runtime lifecycle integration — RED → GREEN

**Files:**
- Modify: `tests/runtime/whatsapp-runtime.test.ts`
- Modify: `src/runtime/compose-whatsapp-runtime.ts`
- Modify: `src/runtime/whatsapp-runtime-supervisor.ts`
- Modify: `src/runtime/whatsapp-runtime-config.ts`
- Modify: `src/main.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes runtime health repository + provider-state callback.
- Produces process instance UUID, required `DEPLOY_REVISION` in release environments, periodic heartbeat, provider transitions and terminal shutdown evidence.

- [ ] Write failing runtime tests for exact deployment-revision validation, lifecycle registration, heartbeat scheduling and stop/failure cleanup.
- [ ] Verify RED.
- [ ] Add release-runtime config for `DEPLOY_REVISION` and heartbeat interval while keeping development/test ergonomics intact.
- [ ] Wire provider CONNECTED/DISCONNECTED events to the repository through composition.
- [ ] Extend supervisor with sequential heartbeat scheduling that never overlaps writes and records terminal shutdown when possible.
- [ ] Verify GREEN on runtime/messaging tests and existing WhatsApp proof.

### Task 4: Final post-deploy smoke semantics — RED → GREEN

**Files:**
- Modify: `db/proofs/phase17_application_smoke_e2e.ts`
- Modify: `src/operations/post-deploy-application-smoke.ts`
- Modify: `scripts/operations/post-deploy-application-smoke.ts`

**Interfaces:**
- Produces provider health where `providerLiveHealth` is HEALTHY only for a matching CONNECTED runtime instance with fresh heartbeat and exact revision/session/environment.

- [ ] Extend E2E first with missing instance, wrong SHA, wrong session, disconnected state, stale heartbeat and healthy exact-match cases.
- [ ] Verify RED against current `NOT_PROBED` behavior.
- [ ] Implement current-instance selection and freshness threshold without provider API calls or secret exposure.
- [ ] Set `finalPostDeploySmokeComplete=true` only when all application and provider-live checks pass.
- [ ] Verify GREEN and preserve operational failure codes.

### Task 5: Fly.io deployment contract — RED → GREEN

**Files:**
- Create: `fly.staging.toml`
- Create: `.github/workflows/staging-runtime-deploy.yml`
- Create: `db/proofs/phase17_fly_deploy_contract_e2e.sh`
- Modify: `.github/workflows/release-foundation-proof.yml`
- Modify: `docs/operations/environments-release.md`
- Modify: `docs/operations/release-recovery-runbook.md`

**Interfaces:**
- Consumes immutable `ghcr.io/otiosun/sla:sha-<full-sha>` artifact and Fly API token from GitHub Environment `staging`.
- Produces a manual, serialized, main-only staging deployment workflow with exact revision binding and post-deploy smoke.

- [ ] Write a failing static contract proof for one Machine, `gru`, 512 MB, always restart, no public HTTP service, immutable SHA image, no source build on Fly, serialized releases, main-only dispatch and smoke after deployment.
- [ ] Verify RED because Fly config/workflow do not exist.
- [ ] Add Fly staging config for a single always-on worker and graceful SIGTERM behavior.
- [ ] Add staging runtime deploy workflow using GitHub Environment `staging`, exact `github.sha`, immutable image, runtime-only secrets and no migration on container startup.
- [ ] Run application smoke after deployment against the exact SHA; smoke failure fails the workflow.
- [ ] Document deploy/rollback by immutable digest/revision and the one-worker invariant.
- [ ] Verify GREEN on contract proof and all permanent checks.

### Task 6: Promotion and canonical sync

- [ ] Audit WIP diff against current main for only intended files, no secrets and no external staging mutation.
- [ ] Require all permanent workflows green on the exact WIP tree.
- [ ] Create a clean exact-tree one-commit candidate on then-current main.
- [ ] Require all pull-request checks green and merge with expected-head SHA.
- [ ] Verify all post-merge checks on the exact main SHA.
- [ ] Update Drive with SHA/tree/PR/workflows/migration 0026 and keep 17.3/17.5 open if no real Fly deployment/provider health was executed.
