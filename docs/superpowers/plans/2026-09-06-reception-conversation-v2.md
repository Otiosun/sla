# Reception Conversation v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile in-memory Reception registration editor with a restart-safe, reply-anchored conversational state machine that autosaves progress, converges both entry modes into automatic review, and stays silent outside explicit user intent.

**Architecture:** Keep `RegistrationService`, immutable review revisions, Player Onboarding, PlayerAccess, Community and Inbox/Outbox as the existing authorities. Add one persisted registration-conversation record per player and perform draft + conversation checkpoint writes under the same PostgreSQL transaction/advisory lock. The WhatsApp layer becomes a thin renderer/orchestrator over this persisted state; freeform remains reply-only to the exact active prompt, while commands remain recovery/compatibility entry points.

**Tech Stack:** Node 24.19.0; pnpm 11.23.0; TypeScript 7.0.2; Vitest 4.1.11; PostgreSQL via `pg` 8.23.0; Baileys 7.0.0-rc14; Zod 4.4.3; Biome 2.5.10.

**Spec:** `docs/superpowers/specs/2026-09-06-reception-conversation-v2-design.md`

## Global Constraints

- Canonical implementation base before this plan: `main@48384689c291ef6d3be1c041b52f492060def652`.
- Existing migrations `0001` through `0033` are immutable; create the next contiguous migration as `0034_registration_conversation_state.sql`.
- PostgreSQL remains the durable authority; no meaningful Reception progress may depend only on process memory.
- One WhatsApp identity maps to one active player/character in v1.
- Region remains Zhoulia and is resolved by canonical ID through `PostgresRegistrationSetupLoader`; do not hardcode a region UUID.
- Starter choice before approval remains intent only; the real Pokémon is still created only during post-approval provisioning.
- Freeform text is processed only when it replies to the exact currently active bot prompt for that player and chat.
- Unknown commands, loose text, loose numbers, replies to humans, and replies to old prompts remain silent.
- Each new prompt invalidates the previous prompt; no arbitrary prompt timeout.
- Every valid answer autosaves the draft/checkpoint but does not submit the registration.
- Submission is explicit and still creates an immutable `registration_revisions` snapshot through the existing Registration domain.
- Normal validation errors are contextual and contain no support code; unexpected system failures keep the existing support-code path.
- Outbox delivery failure never rolls back an already committed domain decision.
- Never weaken TLS, reset the WhatsApp session, rewrite an applied migration, or run two Baileys workers for the same session.
- TDD order is mandatory: observe RED, implement the minimum GREEN, refactor only after GREEN, then run focused and full verification.

---

## File Structure Locked by This Plan

### New files

- `db/migrations/0034_registration_conversation_state.sql` — durable conversation state, active prompt key, CAS revision, replay marker.
- `src/modules/registration/conversation-state.ts` — conversation types, enums, field order, state invariants and pure helpers.
- `src/modules/registration/conversation-renderer.ts` — all player-facing Reception prompts/review/correction/validation copy.
- `tests/db/registration-conversation-state.integration.test.ts` — PostgreSQL persistence, CAS, restart and atomic checkpoint coverage.
- `tests/messaging/whatsapp-reply-quote.test.ts` — durable outbound reply-context + Baileys quote mapping.

### Existing files that will change

- `src/modules/registration/ports.ts` — conversation record/write contracts on the existing Registration transaction boundary.
- `src/platform/registration/postgres-registration-repository.ts` — conversation SQL + player advisory lock + atomic draft/checkpoint writes.
- `src/modules/registration/service.ts` — persisted conversation read/checkpoint/transition APIs.
- `src/modules/registration/conversation-session.ts` — retain only pure parsing/field utilities needed by v2; remove authority from its in-memory session map.
- `src/modules/registration/conversation-resolver.ts` — resolve replies from persisted state, not `RegistrationConversationSessions`.
- `src/modules/registration/whatsapp-handlers.ts` — `$registrar` contextual home plus legacy compatibility mapped into the same persisted state machine.
- `src/modules/messaging/contracts.ts` — typed durable reply context inside WhatsApp text payloads without creating a second transport authority.
- `src/adapters/whatsapp/baileys-provider-contracts.ts` — minimum quoted-message shape required by the adapter.
- `src/adapters/whatsapp/baileys-whatsapp-adapter.ts` — translate persisted reply context into Baileys `quoted` send option.
- `src/runtime/compose-whatsapp-runtime.ts` — compose persisted conversation behavior; stop constructing an authoritative in-memory registration session store.
- `tests/registration/registration-conversation.test.ts` — pure state/parser behavior.
- `tests/registration/reception-ux-polish.test.ts` — progress, acknowledgement, automatic review and contextual error copy.
- `tests/messaging/registration-freeform-intent.test.ts` — exact active-prompt semantics across persisted state.
- `tests/messaging/registration-routing.test.ts` — guided/full/review/edit/pause/resume routes.
- `tests/messaging/registration-ingress.test.ts` — runtime silence boundaries.
- `tests/messaging/operational-registration-composition.test.ts` — real composition and restart reconstruction.
- `db/proofs/reception_registration_e2e.ts` — full Reception journey proof.

---

### Task 1: Persist the Registration Conversation and Make Draft + Conversation Checkpoints Atomic

**Files:**
- Create: `db/migrations/0034_registration_conversation_state.sql`
- Create: `src/modules/registration/conversation-state.ts`
- Modify: `src/modules/registration/ports.ts`
- Modify: `src/platform/registration/postgres-registration-repository.ts`
- Modify: `src/modules/registration/service.ts`
- Create: `tests/db/registration-conversation-state.integration.test.ts`
- Modify: `tests/registration/registration-service.test.ts`

**Interfaces:**
- Produces `RegistrationConversationState`, `RegistrationConversationEditingMode`, `RegistrationConversationField`, `RegistrationConversationRecord`, `SaveRegistrationConversationCheckpointWrite`.
- Produces `RegistrationService.getConversation(playerId)` and `RegistrationService.saveConversationCheckpoint(input)`.
- `saveConversationCheckpoint` accepts `expectedConversationRevision`, `expectedDraftRevision`, `inboxMessageId`, the next conversation record values, and an optional normalized partial draft. It returns `{ conversation, draft, replayed }`.
- The PostgreSQL transaction must acquire `pg_advisory_xact_lock(hashtextextended('registration-player:' || playerId, 0))` before validating both revisions.

- [ ] **Step 1: Write RED DB tests for schema, restart reconstruction, CAS and atomic draft/checkpoint behavior**

```ts
it("persists a guided checkpoint with the draft in one registration transaction", async () => {
  const first = await service.saveConversationCheckpoint({
    playerId,
    chatRef: receptionJid,
    state: "GUIDED_FIELD",
    editingMode: "GUIDED",
    currentField: "age",
    editField: null,
    activePromptOutboxIdempotencyKey: "prompt:age:1",
    expectedConversationRevision: null,
    expectedDraftRevision: null,
    inboxMessageId,
    draft: { trainerName: "Killian", regionId, schemaVersion: 1 },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.conversation.currentField).toBe("age");
  expect(first.value.draft?.snapshot.trainerName).toBe("Killian");
});

it("replays the same inbox transition without incrementing revisions twice", async () => {
  const first = await service.saveConversationCheckpoint(input);
  const replay = await service.saveConversationCheckpoint(input);
  expect(first.ok && replay.ok).toBe(true);
  if (!first.ok || !replay.ok) return;
  expect(replay.value.replayed).toBe(true);
  expect(replay.value.conversation.revision).toBe(first.value.conversation.revision);
  expect(replay.value.draft?.revision).toBe(first.value.draft?.revision);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm vitest run tests/db/registration-conversation-state.integration.test.ts tests/registration/registration-service.test.ts
```

Expected: FAIL because migration `0034`, conversation contracts and service methods do not exist.

- [ ] **Step 3: Add the migration with explicit state constraints**

```sql
CREATE TABLE registration_conversations (
  player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  chat_ref text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'MODE_SELECT','GUIDED_FIELD','FULL_FORM','REVIEW','EDIT_SELECT','EDIT_FIELD',
    'PAUSED','RESUME_MENU','RESTART_CONFIRM','SUBMITTED'
  )),
  editing_mode text NULL CHECK (editing_mode IS NULL OR editing_mode IN ('GUIDED','FULL')),
  current_field text NULL CHECK (current_field IS NULL OR current_field IN (
    'trainerName','age','genderPronouns','appearance','personality','backstory','starterFormId'
  )),
  edit_field text NULL CHECK (edit_field IS NULL OR edit_field IN (
    'trainerName','age','genderPronouns','appearance','personality','backstory','starterFormId'
  )),
  active_prompt_outbox_idempotency_key text NULL,
  draft_revision bigint NULL,
  last_inbox_message_id uuid NULL,
  flow_version integer NOT NULL DEFAULT 2 CHECK (flow_version = 2),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX registration_conversations_active_prompt_idx
  ON registration_conversations(active_prompt_outbox_idempotency_key)
  WHERE active_prompt_outbox_idempotency_key IS NOT NULL;
```

- [ ] **Step 4: Implement the pure conversation types and invariants**

```ts
export const REGISTRATION_CONVERSATION_FIELDS = [
  "trainerName", "age", "genderPronouns", "appearance", "personality", "backstory", "starterFormId",
] as const;

export type RegistrationConversationField = (typeof REGISTRATION_CONVERSATION_FIELDS)[number];
export type RegistrationConversationState =
  | "MODE_SELECT" | "GUIDED_FIELD" | "FULL_FORM" | "REVIEW" | "EDIT_SELECT"
  | "EDIT_FIELD" | "PAUSED" | "RESUME_MENU" | "RESTART_CONFIRM" | "SUBMITTED";
```

Add a pure `assertRegistrationConversationInvariant(record)` that rejects impossible combinations, including `GUIDED_FIELD` without `editingMode === "GUIDED"` or `currentField`, `EDIT_FIELD` without `editField`, and `PAUSED` with an active prompt key.

- [ ] **Step 5: Extend the Registration transaction contract and Postgres implementation**

The write path must lock the player first, load both current records with `FOR UPDATE`, compare expected revisions before any mutation, treat the same `last_inbox_message_id` as a replay, then write draft and conversation before returning. Never commit one side after detecting a mismatch on the other.

- [ ] **Step 6: Implement `RegistrationService.getConversation` and `saveConversationCheckpoint`**

Use `normalizeRegistrationDraft` for partial drafts. Map stale expected revisions to `REVISION_CONFLICT`. Return a stable replay result for the same inbox message.

- [ ] **Step 7: Run focused tests GREEN**

```bash
pnpm vitest run tests/db/registration-conversation-state.integration.test.ts tests/registration/registration-service.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/0034_registration_conversation_state.sql src/modules/registration/conversation-state.ts src/modules/registration/ports.ts src/platform/registration/postgres-registration-repository.ts src/modules/registration/service.ts tests/db/registration-conversation-state.integration.test.ts tests/registration/registration-service.test.ts
git commit -m "feat: persist registration conversation checkpoints"
```

---

### Task 2: Add Durable Reply/Quote Semantics to WhatsApp Outbound Messages

**Files:**
- Modify: `src/modules/messaging/contracts.ts`
- Modify: `src/adapters/whatsapp/baileys-provider-contracts.ts`
- Modify: `src/adapters/whatsapp/baileys-whatsapp-adapter.ts`
- Create: `tests/messaging/whatsapp-reply-quote.test.ts`
- Modify: `tests/messaging/messaging-boundary.test.ts`

**Interfaces:**
- Add a typed `replyTo` object inside WhatsApp TEXT payloads: `{ externalMessageId: string; senderRef: string; text: string }`.
- `replyTo` remains inside the existing persisted Outbox `payload` JSON, so retries/restarts preserve it and no second transport store is introduced.
- `BaileysWhatsAppAdapter` converts that object to the minimum `quoted` message supplied to `socket.sendMessage`.

- [ ] **Step 1: Write RED adapter tests**

```ts
expect(sendMessage).toHaveBeenCalledWith(
  receptionJid,
  { text: "✅ Idade: 19" },
  expect.objectContaining({
    messageId: expect.any(String),
    quoted: expect.objectContaining({
      key: expect.objectContaining({ id: inboundId, remoteJid: receptionJid, participant: playerLid }),
    }),
  }),
);
```

Also prove messages without `payload.replyTo` retain the existing send shape.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/messaging/whatsapp-reply-quote.test.ts tests/messaging/messaging-boundary.test.ts
```

Expected: FAIL because the adapter ignores reply context.

- [ ] **Step 3: Add strict reply payload validation**

Define one Zod schema used by the adapter:

```ts
const WhatsAppReplyContextSchema = z.object({
  externalMessageId: z.string().trim().min(1).max(512),
  senderRef: z.string().trim().min(1).max(512),
  text: z.string().max(32768),
}).strict();
```

Malformed reply context must fail delivery rather than silently quote the wrong message.

- [ ] **Step 4: Map to Baileys quoted message**

Construct:

```ts
const quoted = {
  key: { remoteJid: message.destinationRef, id: reply.externalMessageId, participant: reply.senderRef, fromMe: false },
  message: { conversation: reply.text },
};
```

Pass it only when `replyTo` exists; preserve deterministic outbound `messageId`.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm vitest run tests/messaging/whatsapp-reply-quote.test.ts tests/messaging/messaging-boundary.test.ts
pnpm typecheck
git add src/modules/messaging/contracts.ts src/adapters/whatsapp/baileys-provider-contracts.ts src/adapters/whatsapp/baileys-whatsapp-adapter.ts tests/messaging/whatsapp-reply-quote.test.ts tests/messaging/messaging-boundary.test.ts
git commit -m "feat: reply to triggering WhatsApp messages"
```

---

### Task 3: Fix the Full-Form Parser and Centralize Reception Copy

**Files:**
- Create: `src/modules/registration/conversation-renderer.ts`
- Modify: `src/modules/registration/conversation-session.ts`
- Modify: `tests/registration/registration-conversation.test.ts`
- Modify: `tests/registration/reception-ux-polish.test.ts`

**Interfaces:**
- `parseFullRegistrationTemplate(text)` must accumulate every line after a recognized field header until the next recognized field header.
- Renderer exports `renderModeSelect`, `renderGuidedField`, `renderGuidedAcknowledgement`, `renderFullForm`, `renderReview`, `renderEditSelect`, `renderPause`, `renderResumeMenu`, `renderRestartConfirm`, and `renderValidationRetry`.
- All render functions are pure and contain the only canonical player-facing copy for this flow.

- [ ] **Step 1: Add RED parser cases for multiline appearance/personality/backstory**

```ts
const parsed = parseFullRegistrationTemplate([
  "Nome: Killian",
  "Idade: 19",
  "Gênero / pronomes: masculino / ele",
  "Aparência:",
  "Cabelo preto.",
  "Usa sobretudo claro.",
  "Personalidade:",
  "Reservado.",
  "Observador quando está sob pressão.",
  "História:",
  "Primeira linha.",
  "Segunda linha.",
  "Pokémon inicial: Charmander",
].join("\n"));
expect(parsed.ok && parsed.value.backstory).toBe("Primeira linha.\nSegunda linha.");
```

- [ ] **Step 2: Add RED renderer assertions**

Require `1/7` through `7/7`, explicit acknowledgement of selected mode, automatic review actions `1/2/3`, starters in the full-form prompt, and concise acknowledgements for long fields.

- [ ] **Step 3: Run RED**

```bash
pnpm vitest run tests/registration/registration-conversation.test.ts tests/registration/reception-ux-polish.test.ts
```

Expected: parser and UX assertions fail.

- [ ] **Step 4: Implement multiline parsing**

Maintain `currentField` until another recognized header appears. Blank lines inside a currently open multiline field should be preserved as a single blank line after trimming leading/trailing empty lines. Unknown `Label:` lines are content unless they match a canonical field label; they must never redirect data into another field.

- [ ] **Step 5: Implement the renderer and remove duplicate prompt construction from call sites**

The review renderer must end exactly with:

```text
1 — Enviar para análise
2 — Corrigir alguma informação
3 — Continuar depois
```

Normal validation retries contain no correlation/support code.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm vitest run tests/registration/registration-conversation.test.ts tests/registration/reception-ux-polish.test.ts
pnpm typecheck
git add src/modules/registration/conversation-renderer.ts src/modules/registration/conversation-session.ts tests/registration/registration-conversation.test.ts tests/registration/reception-ux-polish.test.ts
git commit -m "feat: render self-guiding registration conversation"
```

---

### Task 4: Replace In-Memory Freeform Sessions with the Persisted Reply-Anchored State Machine

**Files:**
- Modify: `src/modules/registration/conversation-resolver.ts`
- Modify: `src/modules/registration/whatsapp-handlers.ts`
- Modify: `tests/messaging/registration-freeform-intent.test.ts`
- Modify: `tests/messaging/registration-routing.test.ts`

**Interfaces:**
- `RegistrationConversationResolver` consumes persisted conversation state through `RegistrationService`; it no longer treats `RegistrationConversationSessions` as authority.
- Every conversational outgoing payload includes `replyTo` pointing to `context.message.externalMessageId`, `senderRef`, and original text.
- Every outgoing that expects a further reply persists its own deterministic Outbox idempotency key as `activePromptOutboxIdempotencyKey`.

- [ ] **Step 1: Add RED intent/state-machine cases**

Cover all of these explicitly:

```ts
await expect(admits(looseText)).resolves.toBe(false);
await expect(admits(replyToHuman)).resolves.toBe(false);
await expect(admits(replyToOldPrompt)).resolves.toBe(false);
await expect(admits(replyToExactActivePrompt)).resolves.toBe(true);
```

Also assert that selecting guided mode produces `✅ Modo guiado escolhido` plus `📝 1/7`, and every valid answer persists the next field before the response is returned.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/messaging/registration-freeform-intent.test.ts tests/messaging/registration-routing.test.ts
```

- [ ] **Step 3: Implement exact active-prompt admission from persisted state**

Reuse `PostgresRegistrationReplyIntentVerifier` to prove that the persisted active Outbox key maps to the quoted provider message ID in the same chat. A missing/unsent/orphan prompt is not admissible.

- [ ] **Step 4: Implement guided transitions with autosave**

For a valid guided answer:

```text
validate answer
-> canonicalize starter if field is starterFormId
-> save partial draft + next state + next prompt key atomically
-> return acknowledgement + next prompt as reply to player
```

After the seventh field, transition directly to `REVIEW` and render the whole current draft; do not ask the player to run `$ficha` or `$confirmar`.

- [ ] **Step 5: Implement full-form transition**

A valid full form saves all parsed fields atomically and transitions directly to `REVIEW`. An invalid full form stays in `FULL_FORM` and emits a contextual retry prompt as the new active prompt.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm vitest run tests/messaging/registration-freeform-intent.test.ts tests/messaging/registration-routing.test.ts tests/registration/reception-ux-polish.test.ts
pnpm typecheck
git add src/modules/registration/conversation-resolver.ts src/modules/registration/whatsapp-handlers.ts tests/messaging/registration-freeform-intent.test.ts tests/messaging/registration-routing.test.ts tests/registration/reception-ux-polish.test.ts
git commit -m "feat: drive registration from persisted reply prompts"
```

---

### Task 5: Make `$registrar` the Contextual Home and Add Review/Edit/Pause/Resume/Restart

**Files:**
- Modify: `src/modules/registration/conversation-resolver.ts`
- Modify: `src/modules/registration/whatsapp-handlers.ts`
- Modify: `src/modules/registration/conversation-renderer.ts`
- Modify: `tests/messaging/registration-routing.test.ts`
- Modify: `tests/registration/reception-ux-polish.test.ts`

**Interfaces:**
- `$registrar` derives its response from persisted draft/conversation/current review/PlayerAccess instead of unconditionally starting over.
- `REVIEW` accepts only replies `1`, `2`, `3` to the exact active review prompt.
- `EDIT_SELECT` accepts `1..8`; `EDIT_FIELD` uses the same field validator/canonical starter resolver as guided mode.
- `RESTART_CONFIRM` requires a second explicit confirmation and is the only destructive path.

- [ ] **Step 1: Add RED home-state matrix tests**

Cases:
- no draft/conversation -> `MODE_SELECT`;
- incomplete draft -> `RESUME_MENU`;
- complete unsent draft -> `REVIEW`;
- current `SUBMITTED` -> status-only response, no second draft flow;
- `CHANGES_REQUESTED` -> reopen correction/review from existing draft;
- `APPROVED` or PlayerAccess `ACTIVE` -> registration already complete.

- [ ] **Step 2: Add RED review/edit/pause/restart tests**

Prove `2 -> EDIT_SELECT -> field -> EDIT_FIELD -> corrected value -> REVIEW`; `3 -> PAUSED`; `$registrar` after pause -> `RESUME_MENU`; and restart requires `3 -> RESTART_CONFIRM -> explicit confirmation` before clearing draft/conversation.

- [ ] **Step 3: Run RED**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/registration/reception-ux-polish.test.ts
```

- [ ] **Step 4: Implement the home matrix and review actions**

Use the existing `RegistrationService.getCurrentReview` and PlayerAccess read in composition. Do not infer `REVIEW` merely from a conversation flag: validate the draft with `validateRegistrationDraft` before rendering it as complete.

- [ ] **Step 5: Implement field correction and pause/resume**

After correction, autosave and return immediately to `REVIEW`. `PAUSED` must store `activePromptOutboxIdempotencyKey = null`.

- [ ] **Step 6: Implement restart as a transactional destructive operation**

Add a Registration transaction method that deletes the mutable draft + conversation under the player advisory lock only after `RESTART_CONFIRM`. It must never delete immutable `registration_revisions`, PlayerAccess, onboarding, starter, inventory or world state.

- [ ] **Step 7: Run GREEN and commit**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/registration/reception-ux-polish.test.ts tests/registration/registration-service.test.ts
pnpm typecheck
git add src/modules/registration/conversation-resolver.ts src/modules/registration/whatsapp-handlers.ts src/modules/registration/conversation-renderer.ts src/modules/registration/ports.ts src/modules/registration/service.ts src/platform/registration/postgres-registration-repository.ts tests/messaging/registration-routing.test.ts tests/registration/reception-ux-polish.test.ts tests/registration/registration-service.test.ts
git commit -m "feat: make registrar a contextual conversation home"
```

---

### Task 6: Contextual Validation Errors and Legacy Command Compatibility Without a Parallel Flow

**Files:**
- Modify: `src/modules/registration/conversation-resolver.ts`
- Modify: `src/modules/registration/whatsapp-handlers.ts`
- Modify: `src/modules/messaging/errors.ts`
- Modify: `tests/messaging/registration-routing.test.ts`
- Modify: `tests/messaging/registration-ingress.test.ts`
- Modify: `tests/registration/reception-ux-polish.test.ts`

**Interfaces:**
- Expected registration input errors are rendered inside the Registration flow and return `REGISTRATION_SESSION`, not `MESSAGING_ERROR`.
- Unexpected infrastructure/domain failures still bubble to `presentMessagingError` with support code.
- `$ficha`, `$salvar`, `$continuar`, `$modo`, `$editar`, `$confirmar` and `$confirmar sim` become compatibility aliases into persisted v2 states; none may recreate the old in-memory confirmation maps.

- [ ] **Step 1: Add RED error-recovery tests**

For age `abc`, starter `999`, empty answer, invalid review choice and incomplete full form, assert:

```ts
expect(result.resultRefType).toBe("REGISTRATION_SESSION");
expect(result.outgoing[0]?.payload.text).toContain("⚠️");
expect(result.outgoing[0]?.payload.text).not.toContain("Código de suporte");
```

Then reply to that error message and prove the corrected answer is accepted because the error became the new active prompt.

- [ ] **Step 2: Add RED legacy-command equivalence tests**

`$ficha` renders current review/progress, `$salvar` reports autosave and pauses, `$continuar` routes through the contextual resume behavior, `$confirmar` renders `REVIEW`, and `$confirmar sim` submits only when the persisted conversation is already in `REVIEW` for the same current draft revision.

- [ ] **Step 3: Run RED**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/messaging/registration-ingress.test.ts tests/registration/reception-ux-polish.test.ts
```

- [ ] **Step 4: Implement contextual validation handling**

Catch only known user-input validation failures at the Registration boundary. Re-render the same logical step and persist the new prompt key without changing the draft/current field.

- [ ] **Step 5: Remove `pendingConfirmations` and `pendingWithdrawals` Maps from `whatsapp-handlers.ts`**

Persisted conversation/review state becomes the only source for those decisions. `$editar` while `SUBMITTED` keeps the existing explicit withdraw safety, but the confirmation step is represented by persisted conversation state rather than process memory.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/messaging/registration-ingress.test.ts tests/registration/reception-ux-polish.test.ts
pnpm typecheck
git add src/modules/registration/conversation-resolver.ts src/modules/registration/whatsapp-handlers.ts src/modules/messaging/errors.ts tests/messaging/registration-routing.test.ts tests/messaging/registration-ingress.test.ts tests/registration/reception-ux-polish.test.ts
git commit -m "fix: recover registration validation in conversation"
```

---

### Task 7: Wire Persisted Conversation State into the Real Runtime and Prove Restart/Orphan Recovery

**Files:**
- Modify: `src/runtime/compose-whatsapp-runtime.ts`
- Modify: `src/platform/registration/postgres-registration-reply-intent-verifier.ts`
- Modify: `tests/messaging/operational-registration-composition.test.ts`
- Modify: `tests/messaging/registration-freeform-intent.test.ts`
- Modify: `tests/db/registration-conversation-state.integration.test.ts`

**Interfaces:**
- `createOperationalMessagingComposition` constructs no authoritative `RegistrationConversationSessions` instance.
- `admitFreeform` reads durable state and exact prompt correlation.
- `$registrar` detects a conversation whose active prompt key has no SENT matching Outbox row and regenerates the current prompt with a new deterministic key without advancing the logical state.

- [ ] **Step 1: Add RED restart test**

Create composition A, start guided registration through `age`, discard composition A, create composition B against the same DB, then reply to the persisted age prompt and prove it advances to `genderPronouns` without `$continuar`.

- [ ] **Step 2: Add RED orphan-prompt recovery test**

Persist a conversation with an active prompt key that has no matching SENT outbox row. `$registrar` must return the prompt for the same logical state and replace the active prompt key, not reset the draft.

- [ ] **Step 3: Add RED concurrency test**

Two different inbox messages replying to the same active prompt race concurrently. Exactly one may advance the state; the loser must resolve as stale/ignored or `REVISION_CONFLICT` without overwriting the winner's draft.

- [ ] **Step 4: Run RED**

```bash
pnpm vitest run tests/messaging/operational-registration-composition.test.ts tests/messaging/registration-freeform-intent.test.ts tests/db/registration-conversation-state.integration.test.ts
```

- [ ] **Step 5: Implement runtime wiring and recovery**

Use the same `PostgresRegistrationRepository`, `RegistrationService`, setup loader and reply verifier in handlers/resolver. Preserve the existing unknown-command admission gate and Community onboarding capability checks.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm vitest run tests/messaging/operational-registration-composition.test.ts tests/messaging/registration-freeform-intent.test.ts tests/db/registration-conversation-state.integration.test.ts
pnpm typecheck
git add src/runtime/compose-whatsapp-runtime.ts src/platform/registration/postgres-registration-reply-intent-verifier.ts tests/messaging/operational-registration-composition.test.ts tests/messaging/registration-freeform-intent.test.ts tests/db/registration-conversation-state.integration.test.ts
git commit -m "feat: restore registration conversations after restart"
```

---

### Task 8: Submit Through the Same Registration Domain and Close the Human WhatsApp Journey

**Files:**
- Modify: `src/modules/registration/conversation-resolver.ts`
- Modify: `src/modules/registration/whatsapp-handlers.ts`
- Modify: `db/proofs/reception_registration_e2e.ts`
- Modify: `tests/messaging/registration-routing.test.ts`
- Modify: `tests/registration/admin-review-whatsapp.test.ts`

**Interfaces:**
- Reply `1` in `REVIEW` calls the existing `RegistrationService.saveAndSubmit`/`submit` semantics and then persists conversation `SUBMITTED` with no active prompt.
- The existing immutable revision, admin notification, message-ref mapping, mentions, approval, provisioning and ACTIVE flow remain unchanged.
- Submission must not occur from `GUIDED_FIELD`, `FULL_FORM`, `EDIT_SELECT`, `EDIT_FIELD`, `PAUSED` or stale `REVIEW` tied to an older draft revision.

- [ ] **Step 1: Add RED submit safety tests**

Assert one explicit `REVIEW -> 1` creates exactly one revision; duplicate delivery/replay creates no second revision; stale review after a field edit cannot submit the old snapshot; and `SUBMITTED` `$registrar` reports analysis status rather than opening another flow.

- [ ] **Step 2: Rewrite the Reception E2E proof around the v2 user journey**

The proof must exercise:

```text
$registrar
-> reply 1
-> seven reply-anchored guided answers
-> automatic REVIEW
-> reply 2
-> choose one field
-> correct it
-> automatic REVIEW
-> reply 1
-> SUBMITTED
-> ADM review through existing reply mapping
-> approval/provisioning invariants remain valid
```

Also include a full-form multiline path and deliberate loose chatter/old-prompt replies that produce zero outgoing messages.

- [ ] **Step 3: Run RED**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/registration/admin-review-whatsapp.test.ts
node --import tsx db/proofs/reception_registration_e2e.ts
```

- [ ] **Step 4: Implement submit-state integration**

Use the existing idempotency key derived from the triggering inbox message. After successful submit, clear the active prompt and persist `SUBMITTED`; keep the existing admin notification Outbox semantics.

- [ ] **Step 5: Run focused GREEN and commit**

```bash
pnpm vitest run tests/messaging/registration-routing.test.ts tests/registration/admin-review-whatsapp.test.ts
node --import tsx db/proofs/reception_registration_e2e.ts
pnpm typecheck
git add src/modules/registration/conversation-resolver.ts src/modules/registration/whatsapp-handlers.ts db/proofs/reception_registration_e2e.ts tests/messaging/registration-routing.test.ts tests/registration/admin-review-whatsapp.test.ts
git commit -m "feat: submit reviewed registration conversation"
```

---

### Task 9: Full Regression, Migration Safety, Documentation and Local UAT Candidate

**Files:**
- Modify only if verification exposes a scoped regression: affected tests/source files.
- Update: `docs/superpowers/specs/2026-09-06-reception-conversation-v2-design.md` status line to implementation-ready/implemented as appropriate.
- Update Drive handoff checkpoint after fresh proof.

**Interfaces:**
- Produces one reviewable implementation head; no merge without explicit user authorization.

- [ ] **Step 1: Run formatting/lint/type/unit integration gates**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
```

Expected: all PASS. Fix only regressions caused by this change.

- [ ] **Step 2: Verify migration chain and forward/rollback tooling through the repository's existing CI commands**

Run the same local migration/schema checks used by CI; migration `0034` must apply after immutable `0033` without modifying earlier files.

- [ ] **Step 3: Push the implementation head and require the complete GitHub Actions matrix**

Acceptance: every repository workflow that is green on canonical `main` is green on the implementation head, especially `CI` and `WhatsApp Proof`. Do not call the branch GREEN from focused tests alone.

- [ ] **Step 4: Update canonical Drive checkpoint with evidence**

Record: branch/head, migration number, RED evidence, focused GREEN, full workflow matrix, exact UX invariants, known limitations if any, and next local UAT action.

- [ ] **Step 5: Run local WhatsApp UAT without resetting DB/session**

Use the current demo DB/session and test at minimum:

```text
loose chatter -> silence
unknown command -> silence
old prompt reply -> silence
reply to another player -> silence
$registrar -> contextual home
GUIDED -> acknowledgements + 1/7..7/7 -> automatic REVIEW
invalid value -> contextual retry -> corrected reply accepted
EDIT_FIELD -> REVIEW
pause -> restart runtime -> resume with progress intact
FULL -> multiline blocks -> automatic REVIEW
REVIEW 1 -> one immutable SUBMITTED revision
```

- [ ] **Step 6: Commit final docs-only evidence changes**

```bash
git add docs/superpowers/specs/2026-09-06-reception-conversation-v2-design.md
git commit -m "docs: record Reception conversation v2 verification"
```

Do not merge the implementation PR until the user explicitly authorizes merge after the fresh workflow matrix and local UAT evidence.
