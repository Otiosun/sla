# RPG Pokémon — Recepção, Ficha, Aprovação e Grupos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:test-driven-development for every behavioral slice. Execute one RED/GREEN cycle at a time; no production code before a failing test is observed.

**Goal:** Implement the approved WhatsApp-first Reception/Registration architecture without replacing the existing Player/Starter/World authorities, while keeping future Control Center integration on the same backend operations.

**Architecture:** Add two domain modules: `registration` for human ficha/review/access/provisioning and `community` for group registry/capabilities/presence. Keep `messaging` as transport and `admin` as administrative authority. Registration approval is not gameplay activation: `APPROVED -> PROVISIONING -> ACTIVE` only after existing player/starter/world invariants are satisfied. All group authorization is resolved by provider chatRef/JID + capabilities and fails closed for unknown groups.

**Tech Stack:** TypeScript 7, Node 24.19, Vitest, PostgreSQL, existing shared-kernel Result/idempotency/concurrency primitives, existing Messaging Inbox/Outbox, AdminOperationRegistry, PlayerRegistrationService, PlayerStarterService, WorldService.

**Spec:** `docs/superpowers/specs/2026-09-01-reception-registration-design.md`

## Global constraints

- GitHub is code truth; Drive remains checklist/checkpoint/progress truth.
- Branch only until explicit merge authorization. Never mutate `main` directly.
- Every behavior starts RED and the exact failure is recorded before implementation.
- No final mechanical state is created before administrative approval.
- Submitted revisions are immutable snapshots.
- WhatsApp delivery is never domain authority.
- Unknown groups fail closed.
- No critical JID/chatRef is hardcoded in handlers.
- Existing PlayerRegistrationService, PlayerStarterService and WorldService stay authoritative for their mechanics.
- Approval from WhatsApp and future Control Center must call the same backend review operation.
- No automatic merge.

---

## Task 1 — R1A: Registration contracts and validation — RED/GREEN

**Files**
- Create: `tests/registration/registration-validation.test.ts`
- Create: `src/modules/registration/contracts.ts`
- Create: `src/modules/registration/errors.ts`
- Create: `src/modules/registration/validation.ts`
- Create: `src/modules/registration/index.ts`

**Interfaces**
- `RegistrationDraftInput`
- `RegistrationSnapshot`
- `RegistrationRevisionStatus = SUBMITTED | CHANGES_REQUESTED | APPROVED | REJECTED | WITHDRAWN`
- `validateRegistrationDraft(input)` returning `Result<RegistrationSnapshot>`

**RED behaviors**
- require name, age, gender/pronouns, appearance, personality, backstory, starterFormId and regionId;
- reject ambiguous/invalid age and blank long-text fields;
- normalize harmless whitespace but never invent missing values;
- snapshot output is structurally immutable/read-only to callers.

**GREEN**
- implement only the schema/normalization required by tests;
- no repository, DB or WhatsApp in this task.

**Verify**
- `pnpm vitest run tests/registration/registration-validation.test.ts`
- `pnpm typecheck`

---

## Task 2 — R1B: Draft persistence, immutable submit and sequence — RED/GREEN

**Files**
- Create: `tests/registration/registration-service.test.ts`
- Create: `src/modules/registration/ports.ts`
- Create: `src/modules/registration/service.ts`

**Interfaces**
- `RegistrationRepository.transaction/read`
- transaction methods for draft load/save, current revision, sequence allocation, revision insert/update, idempotency receipt/lock;
- `RegistrationService.saveDraft(...)`
- `RegistrationService.submit(...)`
- `RegistrationService.withdraw(...)`

**RED behaviors**
- save uses `expectedRevision` and rejects stale write;
- submit validates then freezes one immutable snapshot;
- repeated submit with same idempotency key returns the same revision, never a duplicate;
- second genuine submission gets next `sequenceNo`;
- withdraw only current `SUBMITTED` revision;
- editing during review must withdraw old revision before a new submit is possible.

**GREEN**
- service owns state transition rules; repository is persistence only.

**Verify**
- focused Vitest + typecheck.

---

## Task 3 — R1C: Administrative review state machine and concurrency — RED/GREEN

**Files**
- Create: `tests/registration/registration-review.test.ts`
- Modify: `src/modules/registration/contracts.ts`
- Modify: `src/modules/registration/ports.ts`
- Modify: `src/modules/registration/service.ts`

**Interfaces**
- `requestChanges(reviewId, expectedRevision, actor, idempotencyKey)`
- `approve(reviewId, expectedRevision, actor, idempotencyKey)`
- `reject(reviewId, expectedRevision, actor, idempotencyKey)`

**RED behaviors**
- only current `SUBMITTED` review is decidable;
- old/withdrawn/decided review cannot be approved;
- two admins racing produce exactly one state-changing winner;
- duplicate identical approval is idempotent;
- request changes preserves the submitted snapshot as source for later editing;
- rejection creates no mechanical data.

**GREEN**
- first valid optimistic-concurrency commit wins; second receives explicit conflict.

---

## Task 4 — R1D: PostgreSQL registration persistence and migration — RED/GREEN

**Files**
- Create: `tests/db/registration.integration.test.ts`
- Create: `db/migrations/0027_registration_review.sql`
- Create: `src/platform/registration/postgres-registration-repository.ts`
- Modify: `db/bootstrap/runtime_grants.sql` only if least-privilege runtime grants require it.

**Schema**
- `registration_drafts`
- `registration_revisions`
- idempotency/receipt storage needed by registration operations, following existing conventions.

**RED behaviors**
- migration absent/schema proof fails first;
- one draft per player;
- unique `(player_id, sequence_no)`;
- revision snapshot cannot be overwritten after insert;
- stale expected revision update affects zero rows;
- transaction rollback leaves no half-submit.

**GREEN**
- migration is contiguous and immutable after merge;
- repository uses existing retry/transaction infrastructure.

**Verify**
- focused DB test, `pnpm db:verify` in CI database, full `pnpm check` after green.

---

## Task 5 — R2: PlayerAccess + resumable post-approval provisioning — RED/GREEN

**Files**
- Create: `tests/registration/player-provisioning.test.ts`
- Create: `tests/db/player-access.integration.test.ts`
- Create: `db/migrations/0028_player_access.sql`
- Create: `src/modules/registration/provisioning-service.ts`
- Extend: `src/modules/registration/contracts.ts`, `ports.ts`
- Create: `src/platform/registration/postgres-player-access-repository.ts` or fold into the registration repository if transaction boundaries remain cleaner.

**States**
- `PENDING | PROVISIONING | ACTIVE | SUSPENDED`

**RED behaviors**
- approval moves access to PROVISIONING, never directly ACTIVE;
- failure before starter can retry;
- failure after starter cannot duplicate Pokémon;
- failure after onboarding complete can resume location initialization;
- ACTIVE only after approved revision + profile + region + starter grant + onboarding COMPLETE + initial location;
- suspension preserves all mechanical state;
- restore from SUSPENDED does not reprovision.

**GREEN**
- orchestrate existing PlayerRegistrationService, PlayerStarterService and WorldService; do not duplicate their rules.

---

## Task 6 — R3: Community group registry and capabilities — RED/GREEN

**Files**
- Create: `tests/community/community-groups.test.ts`
- Create: `tests/db/community-groups.integration.test.ts`
- Create: `db/migrations/0029_community_groups.sql`
- Create: `src/modules/community/contracts.ts`
- Create: `src/modules/community/ports.ts`
- Create: `src/modules/community/service.ts`
- Create: `src/modules/community/index.ts`
- Create: `src/platform/community/postgres-community-repository.ts`

**Schema**
- `community_groups`
- `community_group_capabilities`
- `reception_staff_assignments`
- `community_member_presence`

**RED behaviors**
- resolve by provider + chatRef/JID, never display name;
- unknown group has zero capabilities and fails closed;
- rename display name does not change authorization;
- multiple RECEPTION groups are valid;
- retired group is not authorized;
- staff assignment does not itself grant Admin capability.

---

## Task 7 — R4: Command policy gate — RED/GREEN

**Files**
- Create: `tests/community/command-policy.test.ts`
- Create: `src/modules/community/command-policy.ts`
- Modify one handler path for each class only after policy tests are green:
  - registration `$registrar`;
  - admin review `$aprovar`;
  - world `$ir`.

**Policy inputs**
- actor identity/admin principal;
- PlayerAccess;
- group capabilities;
- required mechanical state.

**RED behaviors**
- `$registrar` allowed only in onboarding-capable group and non-ACTIVE player;
- `$aprovar` requires both group `admin.review` and admin capability;
- `$ir` denied in Reception even for ACTIVE player;
- `$ir` allowed in `world` group only for ACTIVE player with current world invariants;
- unknown group denies every scoped command.

---

## Task 8 — R5: WhatsApp Registration UX and ephemeral editor — RED/GREEN

**Files**
- Create: `tests/registration/registration-conversation.test.ts`
- Create: `tests/messaging/registration-routing.test.ts`
- Create: `src/modules/registration/conversation-session.ts`
- Create: `src/modules/registration/conversation-resolver.ts`
- Create: `src/modules/registration/whatsapp-handlers.ts`
- Modify: `src/modules/messaging/router.ts` or runtime composition at the narrowest pre-command extension point proven by RED tests.

**Commands**
- `$registrar`, `$continuar`, `$ficha`, `$salvar`, `$editar`, `$modo`, `$confirmar`, `$confirmar sim`.

**RED behaviors**
- normal text is consumed only inside active onboarding session in onboarding-capable group;
- working edits are ephemeral until `$salvar` or `$confirmar sim`;
- restart loses unsaved edits but not persisted draft;
- guided <-> full preserves working values;
- `$confirmar` previews only, `$confirmar sim` persists + submits atomically;
- parser tolerates harmless layout variation and rejects ambiguity.

---

## Task 9 — R6: Admin Review over WhatsApp, reply mapping and real mentions — RED/GREEN

**Files**
- Create: `tests/registration/admin-review-whatsapp.test.ts`
- Create: `tests/messaging/outbox-mentions.test.ts`
- Modify messaging contracts/adapters only as proven necessary by tests for mentions and outbound message IDs.
- Add a durable review-message mapping using existing Outbox metadata if sufficient; otherwise migration `0030_registration_message_refs.sql` + repository.
- Add AdminOperation definitions/capabilities for registration review using the existing registry.

**Commands**
- `$verficha`, `$aprovar`, `$ajustes`, `$rejeitar`.

**RED behaviors**
- reply resolves exact review by provider external message ID;
- reply to obsolete revision fails explicitly;
- manual comment does not change domain state;
- `$ajustes` can change state without embedded comment;
- submission remains SUBMITTED if WhatsApp notification fails;
- zero valid staff does not lose submission;
- valid Reception staff are sent as real mentions;
- future Control Center operation can invoke the same registration review service.

**Security invariant**
- do not broaden Baileys incoming acceptance guard: `event.type === "notify" && event.requestId === undefined` remains intact.

---

## Task 10 — R7: State-aware Reception welcome — RED/GREEN

**Files**
- Create: `tests/community/reception-welcome.test.ts`
- Create: `src/modules/community/reception-service.ts`
- Integrate only first-interaction welcome in current messaging flow.

**RED behaviors**
- no cadastro -> `$registrar` guidance;
- draft -> `$continuar`/`$ficha` guidance;
- SUBMITTED -> in-analysis message;
- CHANGES_REQUESTED -> `$editar` guidance;
- APPROVED + PROVISIONING -> provisioning status;
- ACTIVE -> no novice tutorial;
- leave/rejoin does not reset anything.

**Deferred isolated slice**
- Baileys `group-participants.update` join/leave support. Do not combine it with the first welcome implementation.

---

## Task 11 — Admin catalog, audit and least-privilege integration — RED/GREEN

**Files**
- Modify: `src/modules/admin/registry-catalog.ts`
- Create registration/community AdminOperation definitions.
- Update admin registry seed/proofs.
- Extend audit tests for source channel `WHATSAPP | CONTROL_CENTER` and review/group targets.

**Capabilities**
- `player.registration.read`
- `player.registration.request_changes`
- `player.registration.approve`
- `player.registration.reject`
- `player.registration.reopen`
- `player.access.suspend`
- `player.access.restore`
- `community.group.manage`
- `community.reception.staff.manage`

**RED behaviors**
- WhatsApp group admin status alone grants nothing;
- role packages capabilities; service checks capability not role string;
- Master cannot bypass validation/idempotency/audit.

---

## Task 12 — End-to-end DB proof and staging smoke contract

**Files**
- Create: `db/proofs/reception_registration_e2e.ts`
- Add a focused proof workflow or integrate into an existing appropriate proof workflow after RED.
- Add/update operator docs for configuring Reception JIDs/capabilities/staff without hardcoding.

**E2E proof**
1. new identity in Reception;
2. register guided;
3. partial fill + save;
4. resume + full mode + starter change;
5. preview + submit exactly once;
6. admin staff notification persisted;
7. request changes;
8. edit without data loss;
9. submit next sequence;
10. approve;
11. PROVISIONING;
12. profile/region/starter/onboarding/location materialize;
13. ACTIVE;
14. Reception release announcement queued;
15. world command denied in Reception;
16. same command allowed in world-capable group.

**Staging acceptance**
- real WhatsApp smoke follows the 22-step scenario in the spec;
- no merge/progress claim from a local-only smoke;
- Drive checklist/checkpoint updated only after fresh external evidence.

---

## Commit discipline

Recommended small commits:

1. `test: define registration validation red`
2. `feat: add registration validation core`
3. `test: define registration submit lifecycle red`
4. `feat: add registration submit lifecycle`
5. `test: define registration review concurrency red`
6. `feat: add registration review transitions`
7. `feat: persist registration review state`
8. `feat: add player access provisioning`
9. `feat: add community group registry`
10. `feat: enforce command community policy`
11. `feat: add whatsapp registration conversation`
12. `feat: add whatsapp admin review`
13. `feat: add reception state aware welcome`
14. `feat: integrate registration admin audit`
15. `test: prove reception registration e2e`

Do not squash away the observed RED/GREEN history before review unless explicitly requested.
