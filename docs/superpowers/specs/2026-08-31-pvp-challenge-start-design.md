# FLOW-003 Slice D — PVP Challenge / Accept / Start Design

## Scope

Implement the orchestration that turns two eligible trainers into one deterministic 1v1 PVP Battle. This slice begins at challenge creation and ends with one initial `battle_turn_windows` row in `COLLECTING`. WhatsApp commands, timeout/surrender, ranking/rewards and rematch are explicitly outside this slice.

## Canonical constraints

- PVP reuses Encounter, Battle Engine, snapshots and TurnWindow. No second resolver.
- First supported format is exactly one trainer vs one trainer.
- Each trainer uses the current TEAM roster, slots 1..6.
- `ACCEPT` is final consent for the MVP. No separate READY phase.
- Initial reach policy is explicit `SAME_AREA`; no hidden fallback.
- Challenge, Encounter, Battle and TurnWindow operations are idempotent and concurrent-safe.
- Start must be atomic across Encounter/Battle/snapshot/participants/TurnWindow.
- Existing migrations 0001..0027 are immutable. Slice D adds migration 0028.
- Existing PVE/WILD behavior must remain unchanged.

## Data model

### Encounter participation

Extend `encounters` with `mode TEXT NOT NULL DEFAULT 'PVE' CHECK (mode IN ('PVE','PVP'))`.

Add `encounter_players`:

- `encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE`
- `player_id UUID NOT NULL REFERENCES players(id)`
- `side_no SMALLINT NOT NULL CHECK (side_no > 0)`
- `role TEXT NOT NULL CHECK (role IN ('CHALLENGER','TARGET'))`
- primary key `(encounter_id, player_id)`
- unique `(encounter_id, side_no)`

For new PVE encounters, insert the owner as side 1. For PVP, insert challenger side 1 and target side 2. Historical PVE encounters are backfilled with the owner as side 1.

The existing `encounters.player_id` remains the PVE owner / PVP challenger compatibility owner for this slice. It is not the source of truth for all PVP participants.

Replace the active-encounter exclusivity proof with participant-aware enforcement: a player cannot participate in more than one incompatible active encounter regardless of whether they are `encounters.player_id` or a row in `encounter_players`. The application locks both player rows in deterministic UUID lexical order before ACCEPT/START; the database also carries indexes/constraints needed to reject duplicate active participation.

### PVP challenges

Add `pvp_challenges` with:

- `id UUID PRIMARY KEY`
- `challenger_player_id UUID NOT NULL REFERENCES players(id)`
- `target_player_id UUID NOT NULL REFERENCES players(id)`
- `status TEXT NOT NULL CHECK (status IN ('OPEN','ACCEPTED','DECLINED','CANCELLED','EXPIRED','STARTED'))`
- `format_key TEXT NOT NULL CHECK (format_key = '1V1')`
- `reach_policy TEXT NOT NULL CHECK (reach_policy = 'SAME_AREA')`
- `area_id UUID NOT NULL REFERENCES areas(id)`
- `content_release_id UUID NOT NULL REFERENCES content_releases(id)`
- `ruleset_id UUID NOT NULL REFERENCES rulesets(id)`
- `creation_idempotency_key TEXT NOT NULL`
- `request_fingerprint TEXT NOT NULL`
- `encounter_id UUID NULL UNIQUE REFERENCES encounters(id)`
- `battle_id UUID NULL UNIQUE REFERENCES battles(id)`
- `revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)`
- `created_at`, `updated_at`, `expires_at`, `accepted_at`, `started_at`, `closed_at`

Constraints:

- challenger != target;
- lifecycle timestamps coherent with status;
- expiry strictly after creation;
- unique `(challenger_player_id, creation_idempotency_key)`;
- partial uniqueness prevents more than one OPEN challenge for the same ordered pair and format;
- request fingerprint makes same idempotency key + different target/format a hard conflict.

Challenge expiry is persistent. Restart does not reset it.

## Application services

Create a focused PVP orchestration module rather than extending `EncounterService` with unrelated social policy.

Public application operations:

- `createChallenge(input)`
- `acceptChallenge(input)`
- `declineChallenge(input)`
- `cancelChallenge(input)`
- `getChallenge(input)`
- `startEncounter(input)`

### Create

`createChallenge` validates:

- challenger and target differ;
- both players exist, are ACTIVE and have onboarding COMPLETE;
- PVP feature enabled and format 1V1 supported;
- both have an ACTIVE external identity;
- both have a current area and those areas are identical;
- both have at least one eligible TEAM Pokémon;
- neither has an incompatible active Encounter/Battle;
- active content release and default ruleset are published.

It pins area, release and ruleset, stores an expiry timestamp from the configured challenge TTL and inserts one OPEN challenge. Exact replay returns the same entity. Same idempotency key with a different semantic request returns conflict.

### Accept

Only the target can accept. In one transaction it locks challenger and target in deterministic order, then revalidates all eligibility that could have changed: player status, identity, onboarding, feature/format policy, SAME_AREA, roster, active mechanical conflicts, pinned release/ruleset and challenge expiry/status.

Successful ACCEPT performs exactly once:

1. creates one PVP `encounters` row in `PRESENTED` with challenger as compatibility owner;
2. adds challenger side 1 and target side 2 to `encounter_players`;
3. changes challenge OPEN -> ACCEPTED and links `encounter_id`.

Duplicate ACCEPT returns the existing linked Encounter. Expired OPEN challenge transitions to EXPIRED and creates no Encounter.

### Start

`startEncounter` is allowed for either participant after ACCEPT. In one PostgreSQL transaction it locks both players, challenge and Encounter, revalidates eligibility again, then performs exactly once:

1. Encounter PRESENTED -> ENGAGED;
2. create one Battle with `battle_type='PVP'`, pinned release/ruleset and one encrypted seed;
3. create two `battle_sides` with controller_kind PLAYER and side numbers 1/2;
4. load and snapshot both trainers' eligible TEAM rosters using the same canonical Pokémon build reader used by Battle initialization;
5. create `battle_participants` for every eligible TEAM member;
6. build and persist Battle state snapshot version 0 using the shared initializer;
7. set Battle ACTIVE;
8. open exactly one TurnWindow for battle.version 0 requiring the two player ids / side numbers;
9. Encounter -> IN_BATTLE;
10. Challenge -> STARTED, linking the Battle.

A second concurrent START returns the same Battle and TurnWindow. If any step fails, the entire transaction rolls back.

## Shared Battle initialization refactor

The current PostgreSQL Battle repository contains reusable code that enriches player TEAM rows into `BattlePokemonBuild`, while the current Battle service owns initial-state construction. Slice D extracts these as focused reusable units:

- a PostgreSQL player-party reader that can run on an existing `PoolClient` and pinned `contentReleaseId`;
- a pure initializer that accepts explicit sides/parties and emits a valid `BattleState` for version 0.

PVE/WILD calls the same extracted functions after the refactor. PVP passes PLAYER side 1 and PLAYER side 2. Damage, move validation and turn resolution stay untouched.

## TurnWindow transaction boundary

Extract an internal `openTurnWindowInTransaction(client, input)` primitive from `PostgresBattleTurnWindowRepository.open()`. The public repository method retains its current behavior by wrapping this primitive in `withTransaction`.

PVP START calls the primitive with its already-open `PoolClient`, ensuring Battle + snapshot + participants + TurnWindow commit atomically.

## Eligibility details

`SAME_AREA` is the only v1 reach policy. Unknown/missing policy fails closed.

Roster eligibility for Slice D means:

- placement_kind = TEAM;
- slot_no 1..6;
- Pokémon instance status ACTIVE;
- current_hp > 0;
- pinned release has an active form revision for the Pokémon;
- Nature, Ability and 1..4 move slots required by Battle initialization are resolvable.

At least one eligible Pokémon per trainer is required. The complete eligible TEAM is snapshotted at START; later roster edits cannot change the Battle.

## Concurrency and idempotency

Required proofs:

- duplicate Create with same request -> one Challenge + replay;
- same idempotency key with different request -> conflict;
- self challenge -> rejected;
- non-target ACCEPT -> rejected;
- duplicate ACCEPT -> one Encounter + replay;
- ACCEPT after expiry -> EXPIRED, zero Encounter;
- PVE conflict blocks ACCEPT and PVP accepted participation blocks concurrent PVE creation;
- two START calls -> one Battle, one snapshot v0, two PLAYER sides, one TurnWindow;
- START replay returns same ids without reseeding or reinitializing;
- forced failure after Battle writes but before TurnWindow/Challenge finalization rolls back all START writes;
- PVE Battle initialization regression suite remains green.

## Security / anti-abuse

Challenge/Accept/Start are external mutable surfaces and must integrate with the existing adapter-neutral mutation admission as `BATTLE` surface operations before WhatsApp exposure. No raw external identity is stored in new audit/rate-limit rows.

## Out of scope

- WhatsApp commands and UX;
- timeout/AFK and surrender implementation;
- ranking, rewards, MMR;
- rematch;
- spectator;
- 2v2+;
- Party membership semantics.
