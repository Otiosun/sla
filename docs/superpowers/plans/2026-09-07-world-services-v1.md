# World Services V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add playable Pokemon Mart, Pokemon Center, PC/boxes and fishing flows to the WhatsApp RPG while reusing the canonical world, economy, roster, encounter, battle and capture engines.

**Architecture:** Keep mechanics in existing domain owners and add a focused `world-services` orchestration layer for visit/session/proof state. WhatsApp renderers and reply binding sit above that layer; media support is deferred until text/domain behavior is green. All mutations are idempotent and transactionally atomic.

**Tech Stack:** Node 24.19.0, TypeScript 7.0.2, pnpm 11.23.0, Vitest 4.1.11, PostgreSQL, Zod, Baileys 7.0.0-rc14.

**Spec:** `docs/superpowers/specs/2026-09-07-world-services-v1.md`

## Global Constraints

- Work only on `feat/world-services-v1`.
- Do not alter or merge PR #157.
- Do not deploy to Railway/staging/production.
- Existing migrations are immutable; add new numbered migrations only.
- Preserve current `$` commands while accepting `/` commands.
- Freeform world-service replies require exact active-prompt reply binding.
- No duplicate economy, roster, encounter, battle or capture authority.
- Full repository checks must be green on final head before merge discussion.

---

### Task 1: Dual command prefix compatibility

**Files:**
- Modify: `tests/messaging/command-router-normalization.test.ts`
- Modify: `src/modules/messaging/router.ts`

**Interfaces:**
- Consumes: existing `MessageRouter` route registration and normalization.
- Produces: `$foo` and `/foo` route/classify identically without changing handler input text.

- [ ] **Step 1: Write the failing test**

Add a test proving `/POKÉDEX João Ávila` dispatches to canonical `pokedex`, preserves original message text, and `admitsCommand()` returns true. Add an assertion that `$POKÉDEX` still behaves identically.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/messaging/command-router-normalization.test.ts`
Expected: FAIL because `/` is not currently recognized as a command prefix.

- [ ] **Step 3: Minimal implementation**

Change command token parsing and route-token normalization to accept either leading `$` or `/`. Do not alter text after the command token.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/messaging/command-router-normalization.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression verification**

Run: `pnpm vitest run tests/messaging`
Expected: PASS.

---

### Task 2: Persisted scene proof and facility visit/session foundation

**Files:**
- Create: `db/migrations/0035_world_service_sessions.sql`
- Create: `src/modules/world-services/contracts.ts`
- Create: `src/modules/world-services/errors.ts`
- Create: `src/modules/world-services/ports.ts`
- Create: `src/modules/world-services/session-service.ts`
- Create: `src/platform/world-services/postgres-world-service-repository.ts`
- Create: `tests/world-services/session-service.test.ts`
- Create: `tests/db/world-service-session-migration.test.ts`

**Interfaces:**
- Produces: `WorldServiceSessionService.recordSceneProof()`, `openVisit()`, `closeVisit()`, `loadActiveSession()`, `setActivePrompt()` and exact prompt-reply verification data.
- Persists only scene-proof metadata, not prose.

- [ ] **Step 1: RED domain tests**

Test that a scene proof requires at least 4 non-empty lines, is area-bound, can be consumed once, and opening a visit without a proof fails.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/world-services/session-service.test.ts`
Expected: FAIL because module does not exist.

- [ ] **Step 3: RED migration test**

Test migration creates scene-proof and session tables with player/area/revision constraints and unique active-session semantics.

- [ ] **Step 4: Minimal schema/domain implementation**

Implement specialized state records for `POKEMART`, `POKEMON_CENTER`, and `PC`; use optimistic revision/CAS updates. Store source Inbox id and line count for proofs, never scene text.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm vitest run tests/world-services/session-service.test.ts tests/db/world-service-session-migration.test.ts`
Expected: PASS.

---

### Task 3: WhatsApp facility entry, exit and exact-reply binding

**Files:**
- Create: `src/modules/world-services/whatsapp-handlers.ts`
- Create: `src/modules/world-services/conversation-resolver.ts`
- Create: `src/modules/world-services/renderer.ts`
- Modify: `src/runtime/compose-whatsapp-runtime.ts`
- Create: `tests/messaging/world-services-whatsapp.test.ts`

**Interfaces:**
- Consumes: Task 2 session service, Inbox/Outbox idempotency, existing WorldService location.
- Produces: `/pokemart`, `/centropokemon`, `/pc`, `/sair`; active-prompt freeform resolver.

- [ ] **Step 1: RED routing tests**

Prove entry requires current-area proof, `/sair` closes the visit, numbers not replying to the active prompt are silent, human replies are silent, stale prompt replies are silent, and exact active-prompt replies are consumed.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/messaging/world-services-whatsapp.test.ts`
Expected: FAIL because routes/resolver do not exist.

- [ ] **Step 3: Minimal route/resolver implementation**

Register protected routes through the existing runtime composition. Use persisted provider external message id + outbox idempotency key for exact reply binding.

- [ ] **Step 4: Verify GREEN and messaging regression**

Run: `pnpm vitest run tests/messaging/world-services-whatsapp.test.ts tests/messaging`
Expected: PASS.

---

### Task 4: Atomic quantity purchases for Mart

**Files:**
- Modify: `src/modules/economy/contracts.ts`
- Modify: `src/modules/economy/service.ts`
- Modify: `src/modules/economy/ports.ts`
- Modify: `src/platform/economy/postgres-economy-repository.ts`
- Modify/Create corresponding economy tests under `tests/economy/`
- Extend: `src/modules/world-services/whatsapp-handlers.ts`

**Interfaces:**
- Produces: `EconomyService.purchaseQuantity({ playerId, offerKey, quantity, ... })` returning one atomic receipt.

- [ ] **Step 1: RED tests**

Test quantity multiplier, insufficient wallet rollback, replay idempotency, fingerprint mismatch, and overflow rejection.

- [ ] **Step 2: Verify RED**

Run targeted economy tests; expected FAIL because quantity purchase API is absent.

- [ ] **Step 3: Minimal atomic implementation**

Lock/claim one purchase fingerprint, debit `priceAmount * quantity`, credit `itemQuantity * quantity`, and roll back on any failure.

- [ ] **Step 4: Mart conversation integration**

Render catalog, select item, request quantity by exact reply, execute purchase, acknowledge updated inventory/wallet, then return to Mart menu.

- [ ] **Step 5: Verify GREEN**

Run `pnpm vitest run tests/economy tests/messaging/world-services-whatsapp.test.ts`.

---

### Task 5: Atomic Mart selling

**Files:**
- Add sale-offer schema in a new migration after Task 2 migration.
- Modify economy contracts/ports/service/repository.
- Extend world-services renderer/handlers.
- Add economy + WhatsApp tests.

**Interfaces:**
- Produces: content-driven item sale offers and one atomic inventory-consume + wallet-credit transaction.

- [ ] **Step 1: RED tests**

Test sale lookup, quantity sale, insufficient inventory rollback, replay and price fingerprinting.

- [ ] **Step 2: Minimal implementation**

Use configured sale values only; do not seed invented final prices.

- [ ] **Step 3: Verify GREEN**

Run economy and world-service messaging suites.

---

### Task 6: Pokemon Center party healing

**Files:**
- Create: `src/modules/world-services/healing-service.ts`
- Extend: `src/modules/world-services/ports.ts`
- Extend: `src/platform/world-services/postgres-world-service-repository.ts`
- Extend handlers/renderer.
- Create: `tests/world-services/healing-service.test.ts`

**Interfaces:**
- Produces: idempotent team healing restoring HP, move PP and healable persistent conditions.

- [ ] **Step 1: RED tests**

Test full HP restore, PP restore, condition clear, no BOX healing, no operation during incompatible battle/encounter, and replay.

- [ ] **Step 2: Minimal implementation**

Read canonical team roster; calculate max HP from existing battle/content data; update Pokemon/moves/conditions transactionally and append history/audit evidence.

- [ ] **Step 3: Verify GREEN**

Run targeted world-services tests and battle/capture regressions.

---

### Task 7: Canonical 30-slot box placement and PC moves

**Files:**
- Create shared roster placement helper in `src/modules/player/roster-placement.ts` or the smallest existing canonical owner.
- Modify player and capture Postgres repositories to reuse it.
- Create PC service under `src/modules/world-services/pc-service.ts`.
- Add player/capture/world-services tests.

**Interfaces:**
- Produces: TEAM 1..6 then BOX n slots 1..30; transactional PC move/swap operations.

- [ ] **Step 1: RED placement tests**

Test 6 team slots, Box 1 slots 1..30, Box 2 starts at 1, and capture/starter both use identical placement.

- [ ] **Step 2: Minimal shared implementation**

Eliminate duplicated infinite-Box-1 placement logic.

- [ ] **Step 3: RED PC tests**

Test moving TEAM->BOX, BOX->TEAM, full-team rejection/swap behavior, ownership checks and concurrent revision conflict.

- [ ] **Step 4: Minimal PC implementation and WhatsApp flow**

Use the canonical roster rows directly.

- [ ] **Step 5: Verify GREEN**

Run player/capture/world-services suites.

---

### Task 8: Fishing quota, D20 rarity and Encounter integration

**Files:**
- Add fishing-attempt/config persistence in a new migration.
- Create: `src/modules/world-services/fishing-service.ts`
- Extend world-services ports/repository/handlers/renderer.
- Modify runtime composition to inject canonical `EncounterService` rather than bypass it.
- Create fishing unit/integration tests.

**Interfaces:**
- Produces: idempotent `fish()` result with auditable D20 roll, rarity key, encounter-table slug and canonical Encounter id.

- [ ] **Step 1: RED tests**

Test daily quota, replay, active encounter/battle rejection without quota consumption, boundary D20 tiers, missing table/config failure and successful Encounter delegation.

- [ ] **Step 2: Minimal implementation**

Persist attempt/quota claim transactionally, resolve content config, then call EncounterService with explicit table slug and Inbox-derived idempotency.

- [ ] **Step 3: Verify GREEN**

Run world-services + encounter + battle/capture regressions.

---

### Task 9: Baileys IMAGE outbound support and facility artwork integration

**Files:**
- Modify messaging outbound contracts only as required for a durable image reference.
- Modify `src/adapters/whatsapp/baileys-provider-contracts.ts` if provider typing requires it.
- Modify `src/adapters/whatsapp/baileys-whatsapp-adapter.ts`.
- Extend fake adapter/tests.
- Add facility media references to content/config, not hard-coded mechanics.

**Interfaces:**
- Produces: `IMAGE` outbound with caption; text-only behavior remains unchanged.

- [ ] **Step 1: Ask user for final images**

At this exact stage tell the user it is time to provide/place the Pokemon Mart facade/merchant and Pokemon Center artwork.

- [ ] **Step 2: RED adapter tests**

Test IMAGE payload validation, caption, deterministic message id, provider result id and TEXT regression.

- [ ] **Step 3: Minimal implementation**

Add image sending without granting media any mechanical authority.

- [ ] **Step 4: Verify GREEN**

Run messaging suite and full `pnpm check`.

---

### Task 10: Final verification and local UAT handoff

**Files:**
- Update spec/plan/checkpoint docs only if behavior changed during implementation.

- [ ] **Step 1: Full verification**

Run `pnpm check` and DB tests/migrations.

- [ ] **Step 2: GitHub Actions verification**

Require the repository workflow matrix green on the final head.

- [ ] **Step 3: Local WhatsApp UAT script**

Exercise slash commands, 4-line proof, Mart buy/sell, Center healing, PC boxes, fishing, restart persistence, stale-reply silence and multi-player isolation.

- [ ] **Step 4: Stop before merge**

Do not merge. Report evidence and request explicit user authorization only after UAT closes.
