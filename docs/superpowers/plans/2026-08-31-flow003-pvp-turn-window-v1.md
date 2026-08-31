# FLOW-003 PVP / TurnWindow — implementation plan

**Base commit:** `48d2234129dbfe62374d5c06f08cae292d1236b6`

**Canonical design source:** Google Drive doc `FLOW-003 — Protocolo PVP e TurnWindow v0.1` (`1M91A1AM2pGBxVC7-1qB9JXRLTiG6LWMysN12TJMDh-E`).

## Goal

Add the missing human-vs-human action-collection layer without creating a second battle engine. The existing resolver, rules, damage/status logic, RNG, snapshots and battle events remain authoritative.

The first supported format is 1v1 human vs human. The data contracts should avoid blocking future 2v2+, but those formats remain gated until team composition, retreat and reward policies are explicit.

## Existing boundary

`BattleService.resolvePlayerTurn()` currently resolves the submitting human immediately and asks heuristic AI for every other required side. When another required side is controlled by a PLAYER, it fails with `Multi-player action collection is not enabled in Battle Engine v1`.

The database already has:

- `battles.version` + `turn_number`;
- `battle_sides` and `battle_participants`;
- `battle_actions.expected_battle_version`;
- idempotency and correlation fields;
- state snapshots and battle events;
- deterministic resolver/RNG persistence.

Therefore the missing primitive is a persistent pre-resolution `TurnWindow` plus final atomic commit.

## Invariants

1. At most one active/committable TurnWindow per `(battle_id, battle_version)`.
2. A human action is hidden from opposing players while the window is COLLECTING.
3. At most one ACTIVE submission per required player in a window.
4. Replacing an action never consumes PP/items/RNG and never creates BattleEvents.
5. A LOCKED window never reopens.
6. A COMMITTED window never resolves twice.
7. Deadline is persisted and survives process restart.
8. Commit validates the same `battle.version` that opened the window.
9. Resolver receives only the final action set; it never waits for players.
10. PVP timeout logic is deterministic and never delegated to an LLM.

## Slice A — contracts + RED unit tests

Create:

- `src/modules/battle/turn-window-contracts.ts`
- `src/modules/battle/turn-window-ports.ts`
- `src/modules/battle/turn-window-service.ts`
- `tests/battle/battle-turn-window.test.ts`

Tests first:

- create/open window for an active PVP battle version;
- same idempotency replay;
- conflicting idempotency rejected;
- first human submit remains COLLECTING;
- opponent cannot read payload while COLLECTING;
- replacing own action supersedes prior revision;
- second required submit locks window exactly once;
- stale battle version fails closed;
- submit after LOCK rejected;
- deadline policy is stable/replayable;
- duplicate commit returns replay rather than re-resolving.

No PostgreSQL changes in Slice A.

## Slice B — migration 0027 + repository

Add `db/migrations/0027_battle_turn_windows.sql` with tables equivalent to:

### `battle_turn_windows`

- `id UUID PK`
- `battle_id UUID FK`
- `battle_version BIGINT`
- `turn_number INTEGER`
- `status COLLECTING|LOCKED|COMMITTED|CANCELLED`
- `opened_at`, `deadline_at`, `locked_at`, `committed_at`
- `revision BIGINT`
- `resolution_correlation_id UUID NULL`
- `resolved_battle_version BIGINT NULL`
- policy snapshot/reference
- unique `(battle_id, battle_version)`
- lifecycle coherence checks
- FK to battle snapshot/version where appropriate

### `battle_turn_submissions`

- `id UUID PK`
- `turn_window_id UUID FK`
- `player_id UUID FK`
- `side_no SMALLINT`
- `actor_participant_id UUID`
- `action_type`, `payload JSONB`
- `submission_revision BIGINT`
- `idempotency_key TEXT UNIQUE`
- `status ACTIVE|SUPERSEDED|COMMITTED|REJECTED`
- `submitted_at`, optional terminal timestamp
- causation/correlation metadata
- partial unique index for one ACTIVE submission per `(turn_window_id, player_id)`

Implement `PostgresBattleTurnWindowRepository` using row locks/CAS and the existing retrying transaction infrastructure.

Integration tests must cover concurrent submit, replacement, lock winner and restart/deadline persistence.

## Slice C — atomic commit into the existing resolver

Add a service method that receives the locked final action set and resolves the battle once.

Do not duplicate `resolveTurn()` or damage/status logic.

Refactor the current core only as needed so two paths exist:

- solo PVE convenience path: one human action + server-side AI actions;
- committed action-set path: already-collected human actions + only genuinely non-human actions generated server-side.

Commit transaction must:

1. lock Battle root and TurnWindow;
2. verify expected version/window state;
3. load final submissions;
4. validate actions against the pinned ruleset/current snapshot;
5. derive non-human actions if any;
6. resolve exactly once;
7. persist effective `battle_actions`, events, snapshot, version and RNG counter;
8. mark submissions/window COMMITTED and point to produced battle version;
9. replay the produced snapshot on retry.

## Slice D — Challenge / Accept / Start 1v1

Add a minimal PVP challenge aggregate and persistence contract. Challenge must be explicit consent and must revalidate eligibility at ACCEPT/START.

Do not make Party membership imply challenge acceptance or battle membership.

Required race proofs:

- duplicate challenge request -> one logical challenge;
- duplicate ACCEPT -> same encounter/battle path;
- expired challenge cannot start;
- two concurrent START requests -> one Battle.

## Slice E — timeout, recovery, surrender

- persisted deadline reconciliation;
- first MVP policy defaults to FORFEIT_ON_TIMEOUT unless the pinned ruleset explicitly defines a safe deterministic fallback action;
- process restart does not extend deadline;
- surrender is explicit, idempotent and races safely with turn commit;
- disconnect is not surrender.

## Slice F — messaging integration

Only after the engine/repository proofs are green:

- challenge/accept/decline/status commands;
- turn submission UX;
- never expose opponent action while COLLECTING;
- Inbox/Outbox remains transport boundary;
- no Battle mechanics in WhatsApp handlers.

## Slice G — E2E proof

Prove a real 1v1 lifecycle in PostgreSQL:

challenge -> accept -> start -> multiple committed turns -> terminal result, including duplicate/retry/restart cases.

Only after executable evidence should canonical checklist/checkpoint progress be updated.

## Non-goals for v1

- matchmaking queue;
- spectators;
- rating/MMR;
- PVP currency/reward design;
- 2v2+;
- LLM action selection;
- UI-specific business rules.
