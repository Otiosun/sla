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
import { ok } from "../../src/shared-kernel/result.js";

const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_REF = "120363000000000001@g.us";
const PLAYER_REF = "5511999999999@s.whatsapp.net";
const CURRENT_PROMPT_ID = "BOT-CURRENT-PROMPT";
const ACTIVE_KEY = "registration:active-prompt";

type ReplyIntentInput = Parameters<RegistrationReplyIntentVerifier["isExpectedReply"]>[0];

function messageContext(text: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000003${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000004${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000003${suffix}`,
    idempotencyKey: `inbox:baileys:registration-review-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `registration-review-${suffix}`,
      senderRef: PLAYER_REF,
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T03:30:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: CURRENT_PROMPT_ID,
    },
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

function conversation(
  playerId: PlayerId,
  input: Partial<RegistrationConversationRecord>,
): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state: "REVIEW",
    editingMode: "GUIDED",
    currentField: null,
    editField: null,
    activePromptOutboxIdempotencyKey: ACTIVE_KEY,
    draftRevision: 2,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision: 8,
    ...input,
  };
}

function harness(initialConversation: RegistrationConversationRecord) {
  let currentConversation = initialConversation;
  let currentDraft = completeDraft();
  let draftRevision = 2;
  const checkpoints: Array<Record<string, unknown>> = [];

  const registration = {
    getConversation: async () => ok(currentConversation),
    getDraft: async () =>
      ok({
        playerId: currentConversation.playerId,
        snapshot: currentDraft,
        revision: draftRevision,
      }),
    saveConversationCheckpoint: async (checkpoint: Record<string, unknown>) => {
      checkpoints.push(checkpoint);
      const nextDraft = checkpoint.draft as RegistrationDraftInput | undefined;
      if (nextDraft !== undefined) {
        currentDraft = nextDraft;
        draftRevision += 1;
      }
      currentConversation = {
        ...currentConversation,
        chatRef: String(checkpoint.chatRef),
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
        draft: {
          playerId: currentConversation.playerId,
          snapshot: currentDraft,
          revision: draftRevision,
        },
        replayed: false,
      });
    },
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
          starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
        }),
    },
    replyIntent: {
      isExpectedReply: async (input: ReplyIntentInput) =>
        input.expectedOutboxIdempotencyKey ===
          currentConversation.activePromptOutboxIdempotencyKey &&
        input.replyToExternalMessageId === CURRENT_PROMPT_ID,
    },
  } as never);

  return {
    router: new MessageRouter([], undefined, resolver),
    checkpoints,
    getConversation: () => currentConversation,
    getDraft: () => currentDraft,
  };
}

describe("persisted Registration review and edit flow", () => {
  it("opens the edit selector from REVIEW choice 2", async () => {
    const playerId = createPlayerId();
    const state = harness(conversation(playerId, {}));
    const context = messageContext("2", "01");

    const routed = await state.router.dispatch(context);

    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "✏️ O que deseja corrigir?",
    );
    expect(state.checkpoints[0]).toMatchObject({
      state: "EDIT_SELECT",
      editField: null,
      activePromptOutboxIdempotencyKey: `${context.idempotencyKey}:registration-conversation`,
    });
  });

  it("opens one persisted edit field from EDIT_SELECT", async () => {
    const playerId = createPlayerId();
    const state = harness(conversation(playerId, { state: "EDIT_SELECT" }));
    const context = messageContext("1", "02");

    const routed = await state.router.dispatch(context);

    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("Nome do treinador");
    expect(state.checkpoints[0]).toMatchObject({
      state: "EDIT_FIELD",
      editField: "trainerName",
    });
  });

  it("autosaves the corrected field and returns directly to REVIEW", async () => {
    const playerId = createPlayerId();
    const state = harness(
      conversation(playerId, {
        state: "EDIT_FIELD",
        editField: "trainerName",
      }),
    );
    const context = messageContext("Liora Nova", "03");

    const routed = await state.router.dispatch(context);

    expect(state.getDraft().trainerName).toBe("Liora Nova");
    expect(state.checkpoints[0]).toMatchObject({
      state: "REVIEW",
      editField: null,
      draft: { trainerName: "Liora Nova" },
    });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "📋 FICHA PRONTA PARA REVISÃO",
    );
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("Nome: Liora Nova");
  });

  it("pauses REVIEW without leaving an active freeform prompt", async () => {
    const playerId = createPlayerId();
    const state = harness(conversation(playerId, {}));
    const context = messageContext("3", "04");

    const routed = await state.router.dispatch(context);

    expect(state.checkpoints[0]).toMatchObject({
      state: "PAUSED",
      activePromptOutboxIdempotencyKey: null,
    });
    expect(state.getConversation().activePromptOutboxIdempotencyKey).toBeNull();
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "💾 Seu progresso está salvo.",
    );
  });
});
