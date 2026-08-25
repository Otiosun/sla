# Schema 0001 — invariants and index rationale

This file records implementation-specific decisions aligned with Drive `ARQ-002`.

## Migration boundary

`0001_core_schema.sql` contains relational structure only. It does **not** create login roles, import Pokémon content, execute external APIs, or embed damage/capture formulas. `schema_migrations` is created by the migration runner before numbered migrations so a migration never records itself.

Operational roles are deliberately outside numbered migrations. `db/bootstrap/roles.sql` creates/rotates credentials before migration; `db/bootstrap/runtime_grants.sql` is applied by the migrator after migration and before runtime starts. The post-migration script verifies ownership and its own privilege policy, so deployment fails closed if role separation drifts.

## High-value invariants enforced by PostgreSQL

- external identities are unique by `(provider, external_id)`;
- TEAM slots are only `1..6` and unique per player;
- BOX coordinates are positive and unique, without a hard global box capacity;
- one Pokémon instance has at most one active roster placement;
- roster ownership uses a composite FK to `(pokemon_instance.id, owner_player_id)`;
- Pokémon instances archive logically through `status=ARCHIVED` + `archived_at`, never by deleting the durable Pokémon row;
- trainer unlocks revoke logically through `status=REVOKED` + `revoked_at`;
- encounter entries can be disabled through `active=false`, avoiding destructive draft deletion;
- inventory quantities and trainer progression cannot be negative;
- one incompatible active encounter exists per player;
- battle state uses monotonic `version` for compare-and-swap commits;
- action/outbox/admin/capture/ledger idempotency keys are unique;
- Pokédex enforces `caught_count <= seen_count`;
- an active effect targets exactly one supported entity;
- encounter/battle RNG envelopes require exactly 32-byte ciphertext, 12-byte IV, 16-byte authentication tag and a positive key version.

Wallet non-negativity is deliberately not a cross-table CHECK because `currency_definitions.allows_negative` is data. Normal MVP currencies use conditional debit in the application, avoiding triggers that silently reimplement domain rules.

## Runtime deletion boundary

Runtime receives no table `DELETE` privilege by default. Deletion is explicitly allowlisted only for transient relationship/state rows whose normal domain semantics require removal:

- admin role/capability assignments;
- Pokémon move slots;
- Pokémon roster placement;
- persistent Pokémon conditions;
- active effects.

Durable entities, economy/progression history, audit records and snapshots are not runtime-deletable. Append-only tables additionally deny `UPDATE`/`TRUNCATE`. `schema_migrations` is runtime `SELECT`-only. Retention cleanup for inbox/outbox/history is a future dedicated maintenance capability rather than a side effect of ordinary runtime credentials.

## Battle ownership model

`battle_sides` is the controller/side entity. `battle_participants` belongs to one side and carries the Pokémon snapshot. `battle_actions` uses a composite FK `(actor_participant_id, battle_id)`, preventing an action from referencing a participant from another battle.

## RNG seed storage

Encounter and battle rows store an AES-256-GCM envelope for one 256-bit server CSPRNG seed. The canonical envelope is 32-byte ciphertext + 96-bit IV + 128-bit authentication tag + key version. Encryption/decryption happens in application code and validates those lengths before cryptographic operations. Keys come from external secret configuration and are never persisted in this schema or committed to Git.

## Content release strategy

Stable identities are separate from release-specific revisions. A content release is a resolved snapshot: each active identity has at most one revision for that release. Published immutability is enforced by application/domain authorization in the content phase; no generic mutation trigger is introduced in `0001`.

## Index rationale

Indexes are limited to known access paths: identity lookup, owner/status→Pokémon, roster, ledger timelines, active encounter, battle actions/events, Pokédex, active effects, inbox/outbox queues and audit/admin history. No speculative partitioning or broad JSONB GIN indexes are created; Phase 16 will add indexes only after measured `EXPLAIN/ANALYZE` evidence.

## Transaction patterns

- inventory debit: conditional `UPDATE ... WHERE quantity >= :q RETURNING`;
- battle commit: `UPDATE battles ... WHERE version = :expected RETURNING`;
- exactly-once grants: insert unique ledger/idempotency guard before balance mutation in one transaction;
- outbox rows are persisted with gameplay, while external sends occur after commit.

External network calls are prohibited inside `withTransaction` by engineering contract/review; database code cannot mechanically identify arbitrary network I/O.
