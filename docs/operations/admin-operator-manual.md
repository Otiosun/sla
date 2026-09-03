# Admin operator manual

## Purpose

This is the canonical operational manual for administrators of the Pokémon RPG backend. It explains how an authorized operator is expected to inspect state, prepare mutations, pass safety gates, apply changes and verify evidence without bypassing the deterministic domain services.

The source of truth for permissions remains code, especially `src/modules/admin/registry-catalog.ts`, `src/modules/admin/operation-registry.ts`, each domain `*-definitions.ts` file, and the persisted authorization/audit state. This document is an operator guide, not a second permission registry.

## Non-negotiable boundaries

- Do not use raw SQL as the normal administrative interface.
- Do not directly patch mechanical tables to make an incident "look fixed".
- Do not invent a generic undo. Compensation is semantic and allowlisted.
- Do not bypass `reason`, `expectedRevision`, simulation, confirmation or approval gates declared by an operation policy.
- Do not reuse an `idempotencyKey` for different semantics. Exact retries may replay; changed semantics with the same key must fail.
- Do not approve your own operation when independent approval is required.
- Do not expose sensitive player data, credentials, WhatsApp auth material, secrets or backup artifacts in tickets, chat, Drive or logs.
- `admin.override.invariant` is a Tier 4 capability, not permission for ad-hoc SQL or unregistered writes.
- WhatsApp group-admin status is never RPG authorization. Administrative authority comes from an active AdminPrincipal, registered capabilities and scope.

## Roles

The canonical role-to-capability mapping is `ADMIN_ROLE_CAPABILITIES` in `src/modules/admin/registry-catalog.ts`.

| Role | Intended operational use |
| --- | --- |
| `RECEPTION_MOD` | Least-privilege Reception review: read submitted ficha, request changes, approve or reject. |
| `ADMIN` | Broad day-to-day administration over registered operations up to Tier 3; still subject to capability, scope, validation, idempotency and audit gates. |
| `MASTER_ADMIN` | Full registered capability catalog. Broad authority does not bypass Registry policy, validation, idempotency, expected revisions or audit. |
| `SUPPORT` | Player support, basic player/Pokémon/world/battle reads and low-risk support corrections. |
| `GAME_MASTER` | Narrative/game-master support around encounters, battles, rewards and effects. |
| `ECONOMY_ADMIN` | Economy, inventory and progression adjustments plus low-risk batch tooling. |
| `POKEMON_ADMIN` | Pokémon creation/correction, moves/training/ability/roster/transfer operations and Pokédex correction. |
| `CONTENT_EDITOR` | Content draft creation/editing and validation. |
| `CONTENT_PUBLISHER` | Content validation, publish and archive responsibilities. |
| `SENIOR_ADMIN` | Canonical capabilities whose registered risk tier is at most 3. |
| `OWNER_SECURITY_ADMIN` | Full registered capability catalog, including Tier 4 security/role operations. Use only where that breadth is actually required. |

Least privilege is mandatory. Being operationally convenient is not a reason to assign `OWNER_SECURITY_ADMIN`, `MASTER_ADMIN` or another broader role when `RECEPTION_MOD` is sufficient.

## Reception and WhatsApp configuration

Reception authorization is data-driven. Never hardcode a group name, phone number or JID into command handlers.

A production Reception setup requires all of the following to agree:

1. the WhatsApp group is registered by provider plus exact `chatRef`/JID in the Community Group Registry;
2. the group role is `RECEPTION` and the required capabilities include `onboarding` and/or `admin.review` for the intended surface;
3. each reviewer exists as an active AdminPrincipal with a namespaced WhatsApp identity (`whatsapp:<jid>`);
4. each reviewer has the required granular capability, normally through `RECEPTION_MOD` or another authorized role;
5. each reviewer intended to receive submission notifications is assigned as Reception staff for that registered group;
6. the principal has a scope compatible with the target player when the operation uses subject authorization.

Renaming the WhatsApp group does not change authority because lookup uses provider + `chatRef`/JID. Leaving/rejoining does not reset player data. Removing a user from a group is not the same as suspending `PlayerAccess`.

Registration review operations are shared backend operations, independent of UI transport. WhatsApp uses `sourceChannel=WHATSAPP`; the Control Center uses `sourceChannel=CONTROL_CENTER`. Both must pass the same AdminOperation Registry and leave the same durable audit evidence. The registration review operations are:

- `registration.review.read` → `player.registration.read`;
- `registration.review.request_changes` → `player.registration.request_changes`;
- `registration.review.approve` → `player.registration.approve`;
- `registration.review.reject` → `player.registration.reject`;
- `registration.review.reopen` → `player.registration.reopen`.

Player access and Community administration use the registered capabilities `player.access.suspend`, `player.access.restore`, `community.group.manage` and `community.reception.staff.manage`. Do not reproduce those mutations with raw SQL or transport-specific code.

## Scopes

Authorization is the intersection of capability and scope. Canonical scope types are:

- `GLOBAL`: may authorize global-only operations and subject operations across the installation;
- `PLAYER`: limited to one player target;
- `REGION`: limited to one region target;
- `AREA`: limited to one area target.

A capability without the required scope is denied. A non-global scope does not satisfy an operation registered as `GLOBAL_ONLY`.

## Risk and policy gates

Risk tiers are `0` through `4`. The tier communicates impact, but the actual gates come from each operation's persisted/registered policy: `requiresReason`, `requiresExpectedRevision`, `requiresSimulation`, `requiresConfirmation`, and `requiredApprovals`.

Do not infer gates from the tier alone. For example, the canonical `admin.role.assign` operation is Tier 4 and requires a reason, an expected revision, simulation, explicit confirmation and one independent approval.

Policy drift is fail-closed. If the stored operation snapshot no longer matches the current Registry definition, the operation must not be applied.

## Standard read/support procedure

1. Identify the subject using authorized read/search operations.
2. Prefer Player360 when investigating a player so account, roster, inventory/economy, progression, world, battle/encounter and audit context can be reviewed together.
3. Verify that the target and environment are correct before any mutation is prepared.
4. Record the incident/support correlation identifier externally without copying sensitive payloads.
5. If no mutation is needed, stop after the read and retain only the minimum evidence required by policy.

Sensitive reads require their own capability. Ordinary player read access must not be treated as permission to expose sensitive identity data.

## Standard mutation procedure

Every governed mutation follows the registered state machine rather than a UI-specific shortcut.

### 1. Prepare

Create the mutation with:

- authorized `principalId`;
- exact registered `operationType`;
- validated input;
- `reason` when required;
- current `expectedRevision` when required;
- a unique `idempotencyKey` for this semantic request;
- a `correlationId` linking the operation to its support/incident context.

Before continuing, verify target type/id, risk tier, capability and the operation's policy snapshot.

### 2. Simulate

When required, run `simulate` and inspect the returned `before`, `after` and summary. Simulation is a review gate; it is not permission to apply a surprising result.

If the target changed since the expected revision, discard/reprepare from fresh state rather than overriding the conflict.

### 3. Confirm

When required, the proposing principal runs `confirm` only after reviewing the simulation/current target. Confirmation is tied to the request fingerprint; changing semantics requires a new operation.

### 4. Independent approval

When approvals are required, an authorized principal other than the proposer runs `approve` and supplies a real approval reason. Self-approval is forbidden.

The approver must review target, reason, simulation, expected revision and blast radius. Approval is not a ceremonial click.

### 5. Apply

Only an operation in `READY` may be applied. Use the registered domain operation; never reproduce its mutation with SQL or a second implementation.

An already `APPLIED` operation is treated as convergence/idempotent completion, not a reason to execute the business effect again.

### 6. Verify

After apply:

1. re-read the target/Player360;
2. verify the expected mechanical/economic state;
3. inspect the admin operation/audit evidence;
4. check for unexpected encounter, battle, Outbox or economy side effects when relevant;
5. retain the `correlationId`, operation id and result summary in the incident/support record.

If verification fails, stop new writes and escalate. Do not stack speculative corrective mutations.

## Compensation and mistakes

There is no generic undo/PATCH mechanism. Semantic compensation is intentionally narrow. The currently canonical compensation allowlist is:

- `inventory.adjust`;
- `wallet.adjust`;
- `progression.trainer.adjust`.

A compensation creates new evidence and restores business intent; it does not erase the original audit trail. Operations outside the allowlist require their domain-specific recovery procedure or incident handling.

## Batch operations

Batch execution is not a loop over arbitrary admin writes. Use the batch service contract:

1. preview first;
2. freeze the target set represented by that preview;
3. verify risk/blast radius;
4. execute through the registered low/high-risk batch path;
5. preserve chunk/checkpoint/idempotency evidence;
6. stop on invariant or authorization failure instead of skipping silently.

Never expand the target set after approval by silently rerunning a dynamic query.

## Content operations

Content follows the governed draft/release lifecycle. Draft editing/validation and publishing are separate responsibilities/capabilities. Publishing/rollback must use the registered content services so release pointers and audit evidence remain consistent.

Do not edit already-published catalog rows in place as a shortcut. Prefer a new validated draft/release or the explicit content rollback operation.

## Initial admin bootstrap

The first administrator of a genuinely new staging/production database is a special one-shot ceremony because the ordinary Tier 4 role-assignment workflow requires an already-authorized admin.

Follow `docs/operations/initial-admin-bootstrap.md` and `pnpm ops:bootstrap:admin`. The ceremony creates exactly one GLOBAL `OWNER_SECURITY_ADMIN` and a durable marker. Once bootstrapped, role management returns to the normal governed admin surface. The bootstrap is not a permanent backdoor.

## Incident escalation

Escalate immediately when any of these occurs:

- suspected duplicate reward/economy mutation;
- invariant or revision conflict that cannot be explained by legitimate concurrency;
- admin policy/capability drift;
- unexpected batch blast radius;
- audit evidence missing for a claimed mutation;
- active battle/encounter state becoming mechanically inconsistent;
- database, Outbox/Inbox or provider failure that risks replay or corruption.

Use `docs/operations/release-recovery-runbook.md` and `docs/operations/incident-response.md`. Preserve evidence before attempting recovery.

## Operator completion checklist

An admin task is complete only when the operator can answer all of these:

- Which principal acted, and under which role/capability/scope?
- Which exact registered operation ran?
- What target and `expectedRevision` were reviewed?
- What `idempotencyKey` and `correlationId` identify the request?
- What did simulation show, when required?
- Who confirmed and who independently approved, when required?
- What was applied?
- What post-apply read/audit evidence proves the result?
- If compensation/recovery occurred, where is its separate evidence?
