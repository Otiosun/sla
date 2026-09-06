import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  RegistrationConversationResolver,
  type RegistrationReplyIntentVerifier,
} from "../../src/modules/registration/conversation-resolver.js";
import type { RegistrationConversationRecord } from "../../src/modules/registration/conversation-state.js";
import type { RegistrationDraftInput } from "../../src/modules/registration/contracts.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const SQUIRTLE_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_REF = "120363000000000001@g.us";
const PLAYER_REF = "5511999999999@s.whatsapp.net";
const INITIAL_PROMPT_KEY = "registration:initial-prompt";
const INITIAL_PROMPT_ID = "BOT-INITIAL-PROMPT";

type ReplyIntentInput = Parameters<RegistrationReplyIntentVerifier["isExpectedReply"]>[0];

function providerMessageId(outboxKey: string): string {
  return outboxKey === INITIAL_PROMPT_KEY ? INITIAL_PROMPT_ID : `provider:${outboxKey}`;
}

function messageContext(
  text: string,
  replyToExternalMessageId: string,
  suffix: string,
): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000001${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000002${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000001${suffix}`,
    idempotencyKey: `inbox:baileys:registration-validation-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `registration-validation-${suffix}`,
      senderRef: PLAYER_REF,
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T13:50:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId,
    },
  };
}

function conversation(
  playerId: PlayerId,
  input: Partial<RegistrationConversationRecord>,
): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state: "MODE_SELECT",
    editingMode: null,
    currentField: null,
    editField: null,
    activePromptOutboxIdempotencyKey: INITIAL_PROMPT_KEY,
    draftRevision: null,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision: 4,
    ...input,
  };
}

function completeDraft(): RegistrationDraftInput {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: CHARMANDER_ID,
    regionId: ZHOULIA_ID,
    schemaVersion: 1,
  };
}

function harness(input: {
  readonly initialConversation: RegistrationConversationRecord;
  readonly initialDraft?: RegistrationDraftInput;
}) {
  let currentConversation = input.initialConversation;
  let currentDraft = input.initialDraft;
  let draftRevision = input.initialDraft === undefined ? null : 2;
  const checkpoints: Array<Record<string, unknown>> = [];

  const registration = {
    getConversation: async () => ok(currentConversation),
    getDraft: async () =>
      currentDraft === undefined
        ? err(appError("NOT_FOUND", "No draft"))
        : ok({
            playerId: currentConversation.playerId,
            snapshot: currentDraft,
            revision: draftRevision ?? 0,
          }),
    saveConversationCheckpoint: async (checkpoint: Record<string, unknown>) => {
      checkpoints.push(checkpoint);
      const nextDraft = checkpoint.draft as RegistrationDraftInput | undefined;
      if (nextDraft !== undefined) {
        currentDraft = nextDraft;
        draftRevision = draftRevision === null ? 0 : draftRevision + 1;
      }
      currentConversation = {
        ...currentConversation,
        state: checkpoint.state as RegistrationConversationRecord["state"],
        editingMode: checkpoint.editingMode as RegistrationConversationRecord["editingMode"],
        currentField: checkpoint.currentField as RegistrationConversationRecord["currentField"],
        editField: checkpoint.editField as RegistrationConversationRecord["editField"],
        activePromptOutboxIdempotencyKey: checkpoint.activePromptOutboxIdempotencyKey as
          | string
          | null,
        draftRevision,
        lastInboxMessageId: String(checkpoint.inboxMessageId),
        revision: currentConversation.revision + 1,
      };
      return ok({
        conversation: currentConversation,
        draft:
          currentDraft === undefined
            ? null
            : {
                playerId: currentConversation.playerId,
                snapshot: currentDraft,
                revision: draftRevision ?? 0,
              },
        replayed: false,
      });
    },
    resetMutableRegistration: async () => ok({ reset: true }),
  };

  const resolver = new RegistrationConversationResolver({
    registration,
    community: {
      resolveChat: async () => ({
        known: true,
        groupId: "00000000-0000-4000-8000-000000000201",
        role: "RECEPTION" as const,
        capabilities: ["onboarding" as const, "player.basic" as const],
      }),
    },
    players: {
      resolvePlayer: async () => ok({ playerId: currentConversation.playerId, state: "NEW" }),
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [
            { formId: CHARMANDER_ID, displayName: "Charmander" },
            { formId: SQUIRTLE_ID, displayName: "Squirtle" },
          ],
        }),
    },
    replyIntent: {
      isExpectedReply: async (reply: ReplyIntentInput) =>
        reply.expectedOutboxIdempotencyKey === currentConversation.activePromptOutboxIdempotencyKey &&
        reply.replyToExternalMessageId === providerMessageId(reply.expectedOutboxIdempotencyKey),
    },
  } as never);

  return {
    resolver,
    checkpoints,
    getConversation: () => currentConversation,
    getDraft: () => currentDraft,
  };
}

function expectContextualRetry(
  routed: Awaited<ReturnType<MessageRouter["dispatch"]>>,
  expectedText: string,
): void {
  expect(routed).toMatchObject({
    ok: true,
    value: {
      resultRefType: "REGISTRATION_SESSION",
      outgoing: [{ payload: { text: expect.stringContaining("⚠️") } }],
    },
  });
  expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(expectedText);
  expect(routed.ok && routed.value?.outgoing[0]?.payload.text).not.toContain("Código de suporte");
  expect(routed.ok && routed.value?.outgoing[0]?.payload.text).not.toContain("correlation");
}

describe("persisted Registration contextual validation", () => {
  it("turns an invalid guided age into the new prompt and accepts the corrected reply", async () => {
    const playerId = createPlayerId();
    const draft: RegistrationDraftInput = {
      trainerName: "Liora Vale",
      regionId: ZHOULIA_ID,
      schemaVersion: 1,
    };
    const state = harness({
      initialConversation: conversation(playerId, {
        state: "GUIDED_FIELD",
        editingMode: "GUIDED",
        currentField: "age",
        draftRevision: 2,
      }),
      initialDraft: draft,
    });
    const router = new MessageRouter([], undefined, state.resolver);
    const invalid = messageContext("abc", INITIAL_PROMPT_ID, "11");

    const first = await router.dispatch(invalid);

    expectContextualRetry(first, "📝 2/7 — Idade");
    expect(state.checkpoints[0]).toMatchObject({
      state: "GUIDED_FIELD",
      currentField: "age",
      activePromptOutboxIdempotencyKey: `${invalid.idempotencyKey}:registration-conversation`,
    });
    expect(state.checkpoints[0]).not.toHaveProperty("draft");

    const retryPromptKey = state.getConversation().activePromptOutboxIdempotencyKey;
    if (retryPromptKey === null) throw new Error("retry prompt key missing");
    const corrected = messageContext("19", providerMessageId(retryPromptKey), "12");
    const second = await router.dispatch(corrected);

    expect(second.ok).toBe(true);
    expect(state.getConversation()).toMatchObject({
      state: "GUIDED_FIELD",
      currentField: "genderPronouns",
    });
    expect(state.getDraft()).toMatchObject({ age: 19 });
    expect(second.ok && second.value?.outgoing[0]?.payload.text).toContain("✅ 2/7 — Idade: 19");
    expect(second.ok && second.value?.outgoing[0]?.payload.text).toContain(
      "📝 3/7 — Gênero / pronomes",
    );
  });

  it("keeps an invalid starter in the same guided field with canonical options", async () => {
    const playerId = createPlayerId();
    const draft = completeDraft();
    delete (draft as { starterFormId?: string }).starterFormId;
    const state = harness({
      initialConversation: conversation(playerId, {
        state: "GUIDED_FIELD",
        editingMode: "GUIDED",
        currentField: "starterFormId",
        draftRevision: 2,
      }),
      initialDraft: draft,
    });
    const router = new MessageRouter([], undefined, state.resolver);

    const routed = await router.dispatch(messageContext("999", INITIAL_PROMPT_ID, "13"));

    expectContextualRetry(routed, "📝 7/7 — Pokémon inicial");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("1. Charmander");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("2. Squirtle");
    expect(state.getConversation()).toMatchObject({
      state: "GUIDED_FIELD",
      currentField: "starterFormId",
    });
  });

  it("keeps invalid REVIEW and EDIT_SELECT choices inside their conversational menus", async () => {
    const playerId = createPlayerId();
    const review = harness({
      initialConversation: conversation(playerId, {
        state: "REVIEW",
        editingMode: "GUIDED",
        draftRevision: 2,
      }),
      initialDraft: completeDraft(),
    });
    const reviewRouter = new MessageRouter([], undefined, review.resolver);

    const invalidReview = await reviewRouter.dispatch(
      messageContext("9", INITIAL_PROMPT_ID, "14"),
    );

    expectContextualRetry(invalidReview, "📋 FICHA PRONTA PARA REVISÃO");
    expect(review.getConversation().state).toBe("REVIEW");

    const editPlayerId = createPlayerId();
    const edit = harness({
      initialConversation: conversation(editPlayerId, {
        state: "EDIT_SELECT",
        editingMode: "GUIDED",
        draftRevision: 2,
      }),
      initialDraft: completeDraft(),
    });
    const editRouter = new MessageRouter([], undefined, edit.resolver);

    const invalidEdit = await editRouter.dispatch(messageContext("0", INITIAL_PROMPT_ID, "15"));

    expectContextualRetry(invalidEdit, "✏️ O que deseja corrigir?");
    expect(edit.getConversation().state).toBe("EDIT_SELECT");
  });
});
