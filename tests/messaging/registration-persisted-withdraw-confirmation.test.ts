import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import type { RegistrationConversationRecord } from "../../src/modules/registration/conversation-state.js";
import type { RegistrationSnapshot } from "../../src/modules/registration/contracts.js";
import type { RegistrationRevisionRecord } from "../../src/modules/registration/ports.js";
import { createRegistrationWhatsAppRoutes } from "../../src/modules/registration/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_REF = "120363000000000001@g.us";

function message(text: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000011${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000012${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000011${suffix}`,
    idempotencyKey: `inbox:whatsapp:withdraw-confirm-${suffix}`,
    message: {
      provider: "whatsapp",
      externalMessageId: `withdraw-confirm-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T14:40:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function snapshot(): RegistrationSnapshot {
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

function review(status: RegistrationRevisionRecord["status"]): RegistrationRevisionRecord {
  return {
    id: "00000000-0000-4000-8000-000000001301",
    playerId: PLAYER_ID,
    sequenceNo: 1,
    status,
    snapshot: snapshot(),
    revision: 0,
  };
}

describe("persisted post-submit edit confirmation", () => {
  it("survives a route/runtime restart between $editar and $editar sim", async () => {
    let currentConversation: RegistrationConversationRecord = {
      playerId: PLAYER_ID,
      chatRef: CHAT_REF,
      state: "SUBMITTED",
      editingMode: "GUIDED",
      currentField: null,
      editField: null,
      activePromptOutboxIdempotencyKey: null,
      draftRevision: 2,
      lastInboxMessageId: null,
      flowVersion: 2,
      revision: 8,
    };
    let currentReview = review("SUBMITTED");
    const checkpoints: Array<Record<string, unknown>> = [];
    const withdrawals: Array<Record<string, unknown>> = [];

    const registration = {
      getConversation: async () => ok(currentConversation),
      getDraft: async () => ok({ playerId: PLAYER_ID, snapshot: snapshot(), revision: 2 }),
      getCurrentReview: async () => ok(currentReview),
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
          lastInboxMessageId: String(checkpoint.inboxMessageId),
          revision: currentConversation.revision + 1,
        };
        return ok({ conversation: currentConversation, draft: null, replayed: false });
      },
      withdraw: async (input: Record<string, unknown>) => {
        withdrawals.push(input);
        currentReview = { ...currentReview, status: "WITHDRAWN", revision: 1 };
        return ok(currentReview);
      },
      saveDraft: async () => err(appError("ACTION_INVALID", "unused saveDraft")),
      saveAndSubmit: async () => err(appError("ACTION_INVALID", "unused saveAndSubmit")),
    };

    const shared = {
      players: {
        resolveOrCreatePlayer: async () =>
          ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
        resolvePlayer: async () =>
          ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
      },
      registration,
      setup: {
        load: async () =>
          ok({
            regionId: ZHOULIA_ID,
            regionDisplayName: "Zhoulia",
            starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
          }),
      },
    };

    const routesA = createRegistrationWhatsAppRoutes({
      ...shared,
      sessions: new RegistrationConversationSessions(),
    } as never);
    const editA = routesA.find((route) => route.command === "editar");
    if (editA === undefined) throw new Error("editar route missing");

    const first = await editA.handler.handle(message("$editar", "01"));

    expect(first.ok).toBe(true);
    expect(withdrawals).toHaveLength(0);
    expect(checkpoints.at(-1)).toMatchObject({
      state: "WITHDRAW_CONFIRM",
      activePromptOutboxIdempotencyKey: null,
    });

    // Simulate a Node/runtime restart: all route-local Maps and sessions are gone.
    const routesB = createRegistrationWhatsAppRoutes({
      ...shared,
      sessions: new RegistrationConversationSessions(),
    } as never);
    const editB = routesB.find((route) => route.command === "editar");
    if (editB === undefined) throw new Error("editar route missing after restart");

    const second = await editB.handler.handle(message("$editar sim", "02"));

    expect(second.ok).toBe(true);
    expect(withdrawals).toHaveLength(1);
    expect(checkpoints.at(-1)).toMatchObject({
      state: "EDIT_SELECT",
      activePromptOutboxIdempotencyKey: "inbox:whatsapp:withdraw-confirm-02:registration-command",
    });
    expect(second.ok && second.value.outgoing[0]?.payload.text).toContain(
      "✏️ O que deseja corrigir?",
    );
  });
});
