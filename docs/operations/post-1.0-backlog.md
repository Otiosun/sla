# Post-1.0 Backlog and 1.0 Acceptance Boundary

Status: canonical release-scope boundary for Phase 17.19.
Baseline when this document was created: `main` at `d48d473dcb9f43ef474aea7326361723944a1a4c`.

## Purpose

This document separates deliberately deferred enhancements from unresolved 1.0 acceptance work. A deferred item listed here does not block 1.0. An open Phase 17 acceptance gate does not become post-1.0 work merely because it depends on external infrastructure, provider state, UAT, or a release ceremony.

## Still required for 1.0 acceptance

The following Phase 17 items remain part of the 1.0 release and are **not** backlog:

- 17.5 — post-deploy smoke with provider-live evidence for the exact deployed revision/session.
- 17.7 — human UAT of the complete player/admin flow.
- 17.10 — human UAT of Player 360 and risk-sensitive administrative operations.
- 17.13 — production backup and alert configuration validated against the real target.
- 17.14 — final privacy, secrets, and access review.
- 17.15 — final tag/release and changelog.
- 17.16 — final Drive snapshot with SHA/tag/schema/content release/ruleset.
- 17.17 — technical handoff covering architecture, decisions, known limits, unsupported features, and maintenance.
- 17.18 — initial monitoring window and severity/correction criteria.
- 17.20 — final acceptance with no open P0/P1 blocker and the remaining release invariants satisfied.

These items keep their checklist status independently from this backlog.

## Deferred after 1.0

### Narrative AI N1 affordances

Launch remains on Narrative AI N0. N1 may later add explicitly allowlisted narrative affordances, but it must preserve the existing authority boundary:

- the model never becomes authority for damage, hit, capture, XP, rewards, ownership, or persistent status;
- the model never writes the database directly;
- any N1 affordance must be represented as an explicit validated capability/action before it can influence mechanics;
- malformed, unavailable, low-confidence, timeout, or quota outcomes must continue to fail safely to deterministic mechanics;
- introducing N1 requires its own review, tests, and rollout; it cannot silently reinterpret historical state.

### Trainer progression and tournament product depth

The 1.0 ruleset keeps the already approved `Insígnia` progression identity and `LINEAR_100_V1` level curve. The following product choices remain deliberately deferred:

- definitive sources of Insígnias;
- limits/caps and fine-grained progression balance;
- tournament tiers/categories and formats;
- tournament rewards and reward balance;
- broader tuning of progression pacing.

The current technical slice behavior must not be treated as proof that won battles are the unique or final source of Insígnias.

### PVP and social expansion beyond the current 1v1 foundation

The current deterministic PVP foundation can ship without these extensions:

- explicit timeout/surrender product rules beyond the current core lifecycle;
- ranking and competitive reward systems;
- rematch orchestration;
- spectator mode;
- 2v2 or larger battles;
- broader Party/social convenience features that are not required by the accepted 1v1/PVE flow.

Any future expansion must reuse the Battle/Encounter ownership and deterministic turn-resolution boundaries instead of creating a second mechanical engine.

### Future administrative surfaces

A dedicated web/API/admin-panel surface is an optional future presentation layer, not a prerequisite for the current engine/admin contract. If added later it must:

- reuse `AdminOperationRegistry`, `AdminService`, RBAC/scopes, risk tiers, confirmation/approval, audit, idempotency, and domain owners;
- never expose generic SQL, unrestricted PATCH, or raw invariant-bypassing mutations;
- receive a new surface-specific authorization/security review before production use.

## Backlog governance

Post-1.0 work must follow the same engineering rules as 1.0 work:

1. New behavior is introduced through reviewed GitHub changes and corresponding Drive decisions/checkpoints when applicable.
2. Applied migrations, published content releases, rulesets, battle snapshots, and historical events are never rewritten to make a future feature appear retroactively present.
3. New mechanical authority must be explicit, versioned, validated, and server-authoritative.
4. Backlog completion does not retroactively alter the 1.0 acceptance percentage or waive any Phase 17 release gate.
5. A backlog item promoted into a future release receives its own Definition of Done, tests, operational evidence, and rollout/rollback plan.

## Explicit boundary

This document closes only the scope-separation requirement of checklist item 17.19. It does **not** claim provider-live smoke, human UAT, production backup/alerts validation, privacy/access review, release tagging, final snapshot, handoff, monitoring, or final acceptance.