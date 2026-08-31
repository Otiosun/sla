# PVP Challenge / Accept / Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a durable, concurrent-safe 1v1 PVP challenge lifecycle from Challenge creation through one initial COLLECTING TurnWindow.

**Architecture:** Add migration 0028 for Challenge + Encounter participation, keep PVP orchestration in a focused module, extract reusable Battle player-party initialization primitives, and perform START in one PostgreSQL transaction. Existing PVE/WILD flow remains behaviorally unchanged.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, `pg`, Zod, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-pvp-challenge-start-design.md`

## Global Constraints

- Existing migrations `0001..0027` are immutable.
- First PVP format is exactly `1V1`.
- `ACCEPT` is final consent; no READY phase in Slice D.
- Initial reach policy is exactly `SAME_AREA` and fails closed when unavailable.
- PVP uses the existing Encounter/Battle/TurnWindow stack and the existing deterministic resolver.
- TEAM roster slots are `1..6`; at least one battle-eligible Pokémon is required per player.
- START must atomically persist Encounter, Battle, version-0 snapshot, participants, TurnWindow and Challenge terminal linkage.
- No WhatsApp, timeout/surrender, ranking/reward, rematch, spectator or 2v2+ work in this plan.

---

### Task 1: Freeze Challenge domain contracts with RED tests

**Files:**
- Create: `src/modules/pvp/challenge.ts`
- Create: `tests/pvp/challenge.test.ts`

**Interfaces:**
- Produces `PvpChallenge`, `CreatePvpChallengeInput`, `acceptPvpChallenge`, `declinePvpChallenge`, `cancelPvpChallenge`, `expirePvpChallenge`, `PvpChallengeResult`.
- Challenge statuses: `OPEN | ACCEPTED | DECLINED | CANCELLED | EXPIRED | STARTED`.

- [ ] **Step 1:** Write tests that import the not-yet-existing module and assert self-challenge rejection, exact idempotent create replay semantics, OPEN→ACCEPTED, non-target accept rejection, expiry before accept, and terminal-state immutability.
- [ ] **Step 2:** Open/update a draft stacked PR so CI runs and verify RED is specifically missing `src/modules/pvp/challenge.ts` or missing exports, not fixture/lint noise.
- [ ] **Step 3:** Implement the pure challenge state machine with validated UUIDs/dates, deterministic request fingerprint input fields, revision increments and no database/network code.
- [ ] **Step 4:** Run CI and require challenge unit tests + existing unit suite green.
- [ ] **Step 5:** Commit with `feat(pvp): add challenge lifecycle domain`.

### Task 2: Add migration 0028 and PostgreSQL Challenge repository

**Files:**
- Create: `db/migrations/0028_pvp_challenge_lifecycle.sql`
- Create: `src/modules/pvp/ports.ts`
- Create: `src/platform/pvp/postgres-pvp-challenge-repository.ts`
- Create: `tests/pvp/postgres-pvp-challenge-repository.integration.test.ts`
- Modify: phase/release proofs that explicitly count or name the latest migration.

**Interfaces:**
- Repository transaction loads players in deterministic UUID order, active content, challenge by id/creation key, player mechanical conflicts and TEAM eligibility summary.
- Repository persists challenge lifecycle and ACCEPT-created PVP Encounter participation atomically.

- [ ] **Step 1:** Write PostgreSQL integration RED tests for duplicate create, idempotency fingerprint conflict, expiry, duplicate ACCEPT, same-area failure and participant-aware active encounter conflict.
- [ ] **Step 2:** Verify RED is the absent migration/repository boundary.
- [ ] **Step 3:** Add `encounters.mode`, backfill `encounter_players` for historical PVE rows, create `pvp_challenges`, lifecycle constraints, indexes and participant-aware active-conflict support.
- [ ] **Step 4:** Implement repository methods using `withTransaction`; acquire player locks sorted lexically to prevent lock-order inversion.
- [ ] **Step 5:** Update migration forward/recovery/release proofs from latest migration 0027 to 0028 where those proofs intentionally encode the tip.
- [ ] **Step 6:** Require migration apply/rollback/forward proof + new integration tests green.
- [ ] **Step 7:** Commit with `feat(pvp): persist challenge lifecycle`.

### Task 3: Implement application Create / Accept service

**Files:**
- Create: `src/modules/pvp/service.ts`
- Create: `src/modules/pvp/errors.ts`
- Create: `tests/pvp/service.test.ts`
- Extend: `tests/pvp/postgres-pvp-challenge-repository.integration.test.ts`

**Interfaces:**
- `PvpService.createChallenge(input)` pins area/release/ruleset and expiry.
- `PvpService.acceptChallenge(input)` revalidates both players and returns one linked PVP Encounter.
- Feature input uses existing `FeatureAvailability` semantics.

- [ ] **Step 1:** Write RED service tests for both-player ACTIVE/onboarding/identity/roster checks, SAME_AREA, active Battle/Encounter conflict, published content requirement, duplicate replay and expired accept.
- [ ] **Step 2:** Verify RED on missing `PvpService` behavior.
- [ ] **Step 3:** Implement Create/Accept orchestration using the repository transaction port and existing shared gate/result patterns; no SQL in service.
- [ ] **Step 4:** Add PostgreSQL acceptance proof that target participation blocks a concurrent PVE Encounter path and vice versa.
- [ ] **Step 5:** Run full unit + PostgreSQL suite.
- [ ] **Step 6:** Commit with `feat(pvp): orchestrate challenge acceptance`.

### Task 4: Extract reusable player-party Battle initialization primitives

**Files:**
- Create: `src/platform/battle/postgres-player-party-reader.ts`
- Create: `src/modules/battle/initialization.ts`
- Modify: `src/platform/battle/postgres-battle-repository.ts`
- Modify: `src/modules/battle/service.ts`
- Create/modify: focused Battle initialization regression tests under `tests/battle/`.

**Interfaces:**
- `loadPlayerBattleParty(client, contentReleaseId, playerId): Promise<readonly BattlePokemonBuild[]>`.
- Pure initializer accepts explicit side descriptors and parties, supports PLAYER/WILD/NPC controllers, and returns valid `BattleState` version 0.

- [ ] **Step 1:** Write RED regression tests that express current WILD initialization through the new pure initializer and a new PLAYER-vs-PLAYER initialization case.
- [ ] **Step 2:** Verify RED on absent primitives.
- [ ] **Step 3:** Extract player TEAM enrichment SQL without changing selection semantics: TEAM only, ACTIVE Pokémon, pinned release, Nature, Ability, conditions and 1..4 moves.
- [ ] **Step 4:** Extract initial BattleState construction from `BattleService`; adapt WILD path to consume it.
- [ ] **Step 5:** Run all Battle tests and prove byte/semantic-equivalent WILD behavior through existing assertions.
- [ ] **Step 6:** Commit with `refactor(battle): share party initialization for pvp`.

### Task 5: Add transaction-local TurnWindow opening primitive

**Files:**
- Modify: `src/platform/battle/postgres-battle-turn-window-repository.ts`
- Create/modify: `tests/battle/postgres-battle-turn-window-repository.integration.test.ts`

**Interfaces:**
- Export `openTurnWindowInTransaction(client, input): Promise<TurnWindowResult<OpenTurnWindowOutput>>`.
- Existing `PostgresBattleTurnWindowRepository.open()` becomes a thin `withTransaction` wrapper around that primitive.

- [ ] **Step 1:** Write RED integration test importing the transaction-local primitive and proving replay on `(battle_id,battle_version)`.
- [ ] **Step 2:** Extract the existing INSERT/replay logic verbatim into the primitive.
- [ ] **Step 3:** Run TurnWindow unit/integration tests and existing Slice B/C proofs.
- [ ] **Step 4:** Commit with `refactor(pvp): expose transactional turn-window open`.

### Task 6: Implement atomic START repository/service

**Files:**
- Extend: `src/modules/pvp/ports.ts`
- Extend: `src/modules/pvp/service.ts`
- Create: `src/platform/pvp/postgres-pvp-start-repository.ts`
- Create: `tests/pvp/postgres-pvp-start.integration.test.ts`

**Interfaces:**
- `startEncounter(input)` returns `{ challengeId, encounterId, battleId, turnWindowId, replayed }`.
- Start repository uses one `PoolClient` for all writes and calls `loadPlayerBattleParty` + pure Battle initializer + `openTurnWindowInTransaction`.

- [ ] **Step 1:** Write RED PostgreSQL tests for two concurrent START calls, exact replay, two PLAYER sides, all TEAM participants, one version-0 snapshot, one TurnWindow with two required players, and forced rollback after Battle creation.
- [ ] **Step 2:** Verify RED on absent start repository/service method.
- [ ] **Step 3:** Implement deterministic player/challenge/Encounter locks; revalidate challenge ACCEPTED and both player eligibility.
- [ ] **Step 4:** Create encrypted Battle seed through the existing seed provider contract; insert PVP Battle, sides, participants and state v0; mark Battle ACTIVE; open TurnWindow within the same transaction; move Encounter to IN_BATTLE and Challenge to STARTED.
- [ ] **Step 5:** Implement replay by reading linked Battle/TurnWindow without reseeding or rewriting snapshots.
- [ ] **Step 6:** Run concurrency and rollback tests repeatedly in CI.
- [ ] **Step 7:** Commit with `feat(pvp): start 1v1 battle atomically`.

### Task 7: Gate anti-abuse and close Slice D evidence

**Files:**
- Modify/create focused anti-abuse composition tests as required by existing mutation-admission architecture.
- Modify: `docs/superpowers/plans/2026-08-31-pvp-challenge-start.md` checkboxes only after executable evidence.
- Drive: canonical FLOW-003, Checklist and Checkpoint only after final green head.

**Interfaces:**
- PVP Create/Accept/Start classify as existing mutation surface `BATTLE`; no raw provider identifiers in durable admission rows.

- [ ] **Step 1:** Add RED/GREEN proof that exposed PVP mutations use the existing BATTLE admission surface and idempotent replays do not double charge.
- [ ] **Step 2:** Run complete CI/Release/Battle/Security workflow matrix on one frozen head.
- [ ] **Step 3:** Audit PR diff against its stacked base: only Slice D files, no WhatsApp or unrelated refactors.
- [ ] **Step 4:** Update Drive with exact SHA/run IDs and revision lock. Do not change global progress unless the canonical checklist explicitly awards executable Slice D evidence.
- [ ] **Step 5:** Leave merge decision to the user; do not merge automatically.

## Self-review

- Spec coverage: Challenge lifecycle, ACCEPT, SAME_AREA, roster eligibility, Encounter participants, Battle initialization reuse, atomic START, TurnWindow, concurrency and anti-abuse are each mapped to tasks.
- Placeholder scan: no TBD/TODO/implicit implementation steps.
- Type consistency: Challenge operations live in `src/modules/pvp`; PostgreSQL code lives in `src/platform/pvp`; Battle/TurnWindow primitives remain reusable and adapter-neutral.
- Scope: timeout/surrender and WhatsApp remain Slice E/F and are not pulled into Slice D.
