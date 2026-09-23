# World Services V1 — Design Spec

## Scope

This spec adds playable world services to the WhatsApp RPG without disturbing Reception V2 or the existing battle/capture/economy foundations.

The slice covers:
- Pokemon Mart visit flow, purchase and sale;
- Pokemon Center visit flow and healing;
- PC roster/box management;
- fishing that resolves through the canonical Encounter engine;
- WhatsApp command compatibility for `/` and `$` prefixes;
- persistent, player-scoped service interaction state;
- later outbound image support for facility artwork.

## Non-goals

- No Railway/staging/production rollout.
- No merge of PR #157.
- No generic workflow engine.
- No AI authority over mechanics.
- No duplicate inventory, wallet, roster, battle, capture or encounter subsystem.

## Canonical reuse

- WorldService remains the authority for player location and travel.
- EconomyService remains the authority for wallet/inventory mutations.
- `pokemon_roster_slots` remains the authority for TEAM/BOX placement.
- EncounterService remains the authority for wild Pokemon creation.
- Battle/Capture continue consuming canonical Encounter output.
- Messaging Inbox/Outbox remain the transport boundary and idempotency source.

## Command model

The router accepts both `$command` and `/command` as equivalent input forms. Existing `$` behavior must remain unchanged. New UX copy should prefer `/`.

Unknown commands remain invalid at the router boundary; Reception-specific silence behavior is unchanged.

## Facility visit proof

Mart and Center require one recent, unconsumed scene proof created by a normal player message in the current area with at least four non-empty lines.

Persist only:
- player id;
- area id;
- source Inbox message id;
- counted non-empty line count;
- created/consumed timestamps.

Do not persist the scene prose in the facility proof table.

Opening `/pokemart` or `/centropokemon` consumes one eligible proof and creates a visit session. Actions inside that visit do not require a new scene proof. `/sair` closes the visit.

## Persistent service session

Use a specialized persisted state machine rather than an in-memory or generic workflow engine.

A service session is player-scoped and records:
- service kind (`POKEMART`, `POKEMON_CENTER`, `PC` as required by UX);
- area id;
- state;
- active prompt Outbox idempotency key/provider message id when reply binding is required;
- revision;
- created/updated/closed timestamps.

Freeform numeric or textual replies are consumed only when they are an explicit reply to the currently active service prompt. Replies to humans, stale prompts, normal chatter and unrelated text are silent.

## Mart

### Buy

Server-authoritative offers continue to live in catalog/economy data. A quantity purchase must be one atomic transaction:
- debit `price * quantity` once;
- add `itemQuantity * quantity` once;
- one idempotency fingerprint;
- replay returns the original committed result;
- partial wallet/inventory mutation is impossible.

### Sell

Selling is also atomic:
- consume requested item quantity;
- credit configured sale value * quantity;
- one idempotency fingerprint;
- rollback on insufficient inventory or any write failure.

Sale pricing is content-driven. No invented production prices are seeded until approved content values exist.

## Pokemon Center healing

Healing acts on the current TEAM only.

For each active team Pokemon:
- restore current HP to calculated max HP;
- restore each move slot PP to move max PP;
- clear healable persistent battle conditions according to canonical policy.

The operation is idempotent per triggering Inbox message and records Pokemon history/audit events sufficient to diagnose what changed.

Healing is unavailable while an incompatible battle/encounter flow is active.

## PC and boxes

TEAM remains six slots maximum.

BOX placement is standardized to 30 slots per box. `nextRosterPlacement` behavior used by starter/capture must advance:
- fill team slots 1..6;
- then Box 1 slots 1..30;
- then Box 2 slots 1..30;
- etc.

PC commands manipulate the same `pokemon_roster_slots` rows, never copies.

Moves between TEAM and BOX must be transactional and concurrency-safe. A Pokemon cannot occupy two slots and no slot can contain two Pokemon.

## Fishing

Fishing does not create Pokemon directly.

A fishing action:
1. validates location/content eligibility and daily quota;
2. records the attempt idempotently;
3. resolves one D20 roll with auditable RNG state;
4. maps the roll to a configured fishing rarity tier;
5. resolves the configured encounter-table slug for that tier/location;
6. calls EncounterService to create the canonical wild encounter.

If an incompatible active encounter/battle already exists, fishing must fail without consuming quota.

Daily quota and rarity thresholds are content/ruleset configuration, not hard-coded product assumptions unless explicitly approved.

## Outbound facility images

Image delivery is a transport concern only. Domain services return semantic results; renderers decide text/image composition.

Baileys support will later add an `IMAGE` outbound message type with caption and a durable media reference. No image work starts until text/domain slices are green and the user is explicitly asked to provide the final facility art.

## Delivery order

1. command prefix compatibility;
2. persisted world-service conversation/session foundation + scene proofs;
3. Mart buying;
4. Mart selling;
5. Center healing;
6. PC/30-slot boxes + canonical placement fix;
7. fishing;
8. image transport/rendering;
9. local WhatsApp UAT.

## Safety and release gates

- Work only on `feat/world-services-v1`.
- Main is not modified directly.
- PR #157 remains untouched and unmerged.
- Every behavior change uses RED -> GREEN tests.
- Existing migrations remain immutable; new schema changes use new migration numbers.
- Final head must pass the full repository verification matrix before any merge discussion.
