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
const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_REF = "120363000000000001@g.us";
const PLAYER_REF = "5511999999999@s.whatsapp.net";
const CURRENT_PROMPT_ID = "BOT-CURRENT-REVIEW";
const ACTIVE_KEY = "registration:review:active";

type ReplyIntentInput = Parameters<RegistrationReplyIntentVerifier["isExpectedReply"]>[0];

function context(suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000007${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000008${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000007${suffix}`,
    idempotencyKey: `inbox:baileys:registration-submit-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `registration-submit-${suffix}`,
      senderRef: PLAYER_REF,
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T16:10:00.000-03:00",
      text: "1",
      mediaRefs: [],
      replyToExternalMessageId: CURRENT_PROMPT_ID,
    },
  };
}

function draft(): RegistrationDraftInput {
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

function conversation(playerId: PlayerId, draftRevision = 2): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state: "REVIEW",
    editingMode: "GUIDED",
    currentField: null,
    editField: null,
    activePromptOutboxIdempotencyKey: ACTIVE_KEY,
    draftRevision,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision: 8,
  };
}

function harness(input: {
  readonly draftRevision?: number;
  readonly conversationDraftRevision?: number;
}) {
  const playerId = createPlayerId();
  let currentConversation = conversation(playerId, input.conversationDraftRevision ?? 2);
  const currentDraft = draft();
  const currentDraftRevision = input.draftRevision ?? 2;
  const checkpoints: Array<Record<string, unknown>> = [];
  const submitCalls: Array<Record<string, unknown>> = [];

  const registration = {
    getConversation: async () => ok(currentConversation),
    getDraft: async () =>
      ok({
        playerId,
        snapshot: currentDraft,
        revision: currentDraftRevision,
      }),
    saveConversationCheckpoint: async (checkpoint: Record<string, unknown>) => {
      checkpoints.push(checkpoint);
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
        draftRevision: currentDraftRevision,
        lastInboxMessageId: String(checkpoint.inboxMessageId),
        revision: currentConversation.revision + 1,
      };
      return ok({
        conversation: currentConversation,
        draft: { playerId, snapshot: currentDraft, revision: currentDraftRevision },
        replayed: false,
      });
    },
    submit: async (inputValue: Record<string, unknown>) => {
      submitCalls.push(inputValue);
      return ok({
        id: REVIEW_ID,
        playerId,
        sequenceNo: 1,
        status: "SUBMITTED" as const,
        snapshot: currentDraft as Required<RegistrationDraftInput>,
        revision: 0,
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
      resolvePlayer: async () => ok({ playerId, state: "NEW" }),
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
      isExpectedReply: async (intent: ReplyIntentInput) =>
        intent.expectedOutboxIdempotencyKey ===
          currentConversation.activePromptOutboxIdempotencyKey &&
        intent.replyToExternalMessageId === CURRENT_PROMPT_ID,
    },
  } as never);

  return {
    router: new MessageRouter([], undefined, resolver),
    playerId,
    checkpoints,
    submitCalls,
    getConversation: () => currentConversation,
  };
}

describe("persisted Registration review submission", () => {
  it("submits REVIEW choice 1 once and persists SUBMITTED before returning", async () => {
    const state = harness({});
    const message = context("01");

    const result = await state.router.dispatch(message);

    expect(state.submitCalls).toEqual([
      {
        playerId: state.playerId,
        idempotencyKey: `${message.idempotencyKey}:registration-submit`,
      },
    ]);
    expect(state.checkpoints.at(-1)).toMatchObject({
      state: "SUBMITTED",
      activePromptOutboxIdempotencyKey: null,
      expectedConversationRevision: 8,
      expectedDraftRevision: 2,
    });
    expect(state.getConversation().state).toBe("SUBMITTED");
    expect(result.ok && result.value?.outgoing[0]?.payload.text).toMatch(/enviada.*análise/i);
    expect(result.ok && result.value?.outgoing[1]?.payload).toMatchObject({
      registrationReview: {
        reviewId: REVIEW_ID,
        reviewRevision: 0,
      },
    });
  });

  it("does not submit a duplicate delivery after the conversation is already SUBMITTED", async () => {
    const state = harness({});
    const message = context("02");

    const first = await state.router.dispatch(message);
    const replay = await state.router.dispatch(message);

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: true, value: null });
    expect(state.submitCalls).toHaveLength(1);
  });

  it("refuses a stale REVIEW tied to an older draft and reopens review on the current draft", async () => {
    const state = harness({ draftRevision: 3, conversationDraftRevision: 2 });
    const message = context("03");

    const result = await state.router.dispatch(message);

    expect(state.submitCalls).toHaveLength(0);
    expect(state.checkpoints.at(-1)).toMatchObject({
      state: "REVIEW",
      activePromptOutboxIdempotencyKey: `${message.idempotencyKey}:registration-conversation`,
      expectedConversationRevision: 8,
      expectedDraftRevision: 3,
    });
    expect(result.ok && result.value?.outgoing[0]?.payload.text).toMatch(/mudou.*rev/i);
    expect(result.ok && result.value?.outgoing[0]?.payload.text).toContain(
      "📋 FICHA PRONTA PARA REVISÃO",
    );
  });
});
