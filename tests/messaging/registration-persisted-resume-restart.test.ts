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
    inboxMessageId: `00000000-0000-4000-8000-0000000008${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000009${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000008${suffix}`,
    idempotencyKey: `inbox:baileys:registration-resume-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `registration-resume-${suffix}`,
      senderRef: PLAYER_REF,
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T04:30:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: CURRENT_PROMPT_ID,
    },
  };
}

function conversation(
  playerId: PlayerId,
  state: RegistrationConversationRecord["state"],
): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state,
    editingMode: "GUIDED",
    currentField: null,
    editField: null,
    activePromptOutboxIdempotencyKey: ACTIVE_KEY,
    draftRevision: 2,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision: 10,
  };
}

function harness(initialState: RegistrationConversationRecord["state"]) {
  const playerId = createPlayerId();
  let currentConversation: RegistrationConversationRecord | undefined = conversation(
    playerId,
    initialState,
  );
  let currentDraft: RegistrationDraftInput | undefined = {
    trainerName: "Liora Vale",
    regionId: ZHOULIA_ID,
    schemaVersion: 1,
  };
  let draftRevision: number | null = 2;
  const checkpoints: Array<Record<string, unknown>> = [];
  const resets: Array<Record<string, unknown>> = [];

  const registration = {
    getConversation: async () =>
      currentConversation === undefined
        ? { ok: false as const, error: { code: "NOT_FOUND", message: "missing" } }
        : ok(currentConversation),
    getDraft: async () =>
      currentDraft === undefined
        ? { ok: false as const, error: { code: "NOT_FOUND", message: "missing" } }
        : ok({ playerId, snapshot: currentDraft, revision: draftRevision ?? 0 }),
    saveConversationCheckpoint: async (checkpoint: Record<string, unknown>) => {
      checkpoints.push(checkpoint);
      currentConversation = {
        playerId,
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
        flowVersion: 2,
        revision: (currentConversation?.revision ?? -1) + 1,
      };
      return ok({ conversation: currentConversation, draft: null, replayed: false });
    },
    resetMutableRegistration: async (input: Record<string, unknown>) => {
      resets.push(input);
      currentConversation = undefined;
      currentDraft = undefined;
      draftRevision = null;
      return ok({ reset: true as const });
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
      isExpectedReply: async (input: ReplyIntentInput) =>
        input.expectedOutboxIdempotencyKey ===
          currentConversation?.activePromptOutboxIdempotencyKey &&
        input.replyToExternalMessageId === CURRENT_PROMPT_ID,
    },
  } as never);

  return {
    router: new MessageRouter([], undefined, resolver),
    checkpoints,
    resets,
    getConversation: () => currentConversation,
    getDraft: () => currentDraft,
  };
}

describe("persisted Registration resume and restart flow", () => {
  it("continues an incomplete GUIDED draft from RESUME_MENU choice 1", async () => {
    const state = harness("RESUME_MENU");
    const context = messageContext("1", "01");

    const routed = await state.router.dispatch(context);

    expect(state.checkpoints[0]).toMatchObject({
      state: "GUIDED_FIELD",
      currentField: "age",
    });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("📝 2/7 — Idade");
  });

  it("requires a second explicit choice before destructive restart", async () => {
    const state = harness("RESUME_MENU");
    const context = messageContext("3", "02");

    const routed = await state.router.dispatch(context);

    expect(state.resets).toHaveLength(0);
    expect(state.checkpoints[0]).toMatchObject({ state: "RESTART_CONFIRM" });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "⚠️ Recomeçar apaga o rascunho atual.",
    );
  });

  it("cancels RESTART_CONFIRM without deleting mutable progress", async () => {
    const state = harness("RESTART_CONFIRM");
    const context = messageContext("2", "03");

    const routed = await state.router.dispatch(context);

    expect(state.resets).toHaveLength(0);
    expect(state.getDraft()).toBeDefined();
    expect(state.checkpoints[0]).toMatchObject({ state: "RESUME_MENU" });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("ficha em andamento");
  });

  it("clears only mutable progress after confirmed restart and opens a fresh mode prompt", async () => {
    const state = harness("RESTART_CONFIRM");
    const context = messageContext("1", "04");

    const routed = await state.router.dispatch(context);

    expect(state.resets).toHaveLength(1);
    expect(state.getDraft()).toBeUndefined();
    expect(state.checkpoints.at(-1)).toMatchObject({
      state: "MODE_SELECT",
      expectedConversationRevision: null,
      expectedDraftRevision: null,
    });
    expect(state.getConversation()?.state).toBe("MODE_SELECT");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "Escolha como prefere preencher",
    );
  });
});
