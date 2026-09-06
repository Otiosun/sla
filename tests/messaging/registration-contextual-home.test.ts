import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import type { RegistrationConversationRecord } from "../../src/modules/registration/conversation-state.js";
import type {
  RegistrationDraftInput,
  RegistrationSnapshot,
} from "../../src/modules/registration/contracts.js";
import type { RegistrationRevisionRecord } from "../../src/modules/registration/ports.js";
import { createRegistrationWhatsAppRoutes } from "../../src/modules/registration/whatsapp-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_REF = "120363000000000001@g.us";

function context(suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000005${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000006${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000005${suffix}`,
    idempotencyKey: `inbox:whatsapp:registrar-home-${suffix}`,
    message: {
      provider: "whatsapp",
      externalMessageId: `registrar-home-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T04:00:00.000-03:00",
      text: "$registrar",
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function completeDraft(): RegistrationSnapshot {
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
  state: RegistrationConversationRecord["state"],
  revision = 3,
): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state,
    editingMode: state === "MODE_SELECT" ? null : "GUIDED",
    currentField: state === "GUIDED_FIELD" ? "age" : null,
    editField: null,
    activePromptOutboxIdempotencyKey:
      state === "PAUSED" || state === "SUBMITTED" ? null : "old:prompt",
    draftRevision: 2,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision,
  };
}

function revision(status: RegistrationRevisionRecord["status"]): RegistrationRevisionRecord {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    playerId: PLAYER_ID,
    sequenceNo: 1,
    status,
    snapshot: completeDraft(),
    revision: 0,
  };
}

function harness(input: {
  readonly conversation?: RegistrationConversationRecord;
  readonly draft?: RegistrationDraftInput;
  readonly review?: RegistrationRevisionRecord;
}) {
  let currentConversation = input.conversation;
  const currentDraft = input.draft;
  const checkpoints: Array<Record<string, unknown>> = [];

  const dependencies = {
    sessions: new RegistrationConversationSessions(),
    players: {
      resolveOrCreatePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
    },
    registration: {
      getConversation: async () =>
        currentConversation === undefined
          ? err(appError("NOT_FOUND", "Registration conversation not found"))
          : ok(currentConversation),
      getDraft: async () =>
        currentDraft === undefined
          ? err(appError("NOT_FOUND", "Registration draft not found"))
          : ok({ playerId: PLAYER_ID, snapshot: currentDraft, revision: 2 }),
      getCurrentReview: async () =>
        input.review === undefined
          ? err(appError("NOT_FOUND", "Current registration review not found"))
          : ok(input.review),
      saveConversationCheckpoint: async (checkpoint: Record<string, unknown>) => {
        checkpoints.push(checkpoint);
        currentConversation = {
          playerId: PLAYER_ID,
          chatRef: String(checkpoint.chatRef),
          state: checkpoint.state as RegistrationConversationRecord["state"],
          editingMode: checkpoint.editingMode as RegistrationConversationRecord["editingMode"],
          currentField: checkpoint.currentField as RegistrationConversationRecord["currentField"],
          editField: checkpoint.editField as RegistrationConversationRecord["editField"],
          activePromptOutboxIdempotencyKey: checkpoint.activePromptOutboxIdempotencyKey as
            | string
            | null,
          draftRevision: currentDraft === undefined ? null : 2,
          lastInboxMessageId: String(checkpoint.inboxMessageId),
          flowVersion: 2,
          revision: (currentConversation?.revision ?? -1) + 1,
        };
        return ok({ conversation: currentConversation, draft: null, replayed: false });
      },
      saveDraft: async () => err(appError("ACTION_INVALID", "unused saveDraft")),
      saveAndSubmit: async () => err(appError("ACTION_INVALID", "unused saveAndSubmit")),
      withdraw: async () => err(appError("ACTION_INVALID", "unused withdraw")),
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
        }),
    },
  };

  const registrar = createRegistrationWhatsAppRoutes(dependencies as never).find(
    (candidate) => candidate.command === "registrar",
  );
  if (registrar === undefined) throw new Error("registrar route missing");

  return { registrar, checkpoints };
}

describe("contextual $registrar home", () => {
  it("offers resume actions for an incomplete persisted draft", async () => {
    const state = harness({
      conversation: conversation(PLAYER_ID, "PAUSED"),
      draft: { trainerName: "Liora Vale", regionId: ZHOULIA_ID, schemaVersion: 1 },
    });

    const result = await state.registrar.handler.handle(context("01"));

    expect(result.ok && result.value.outgoing[0]?.payload.text).toContain("ficha em andamento");
    expect(result.ok && result.value.outgoing[0]?.payload.text).toContain("1 — Continuar");
    expect(state.checkpoints[0]).toMatchObject({ state: "RESUME_MENU" });
  });

  it("opens REVIEW immediately for a complete unsent draft", async () => {
    const state = harness({
      conversation: conversation(PLAYER_ID, "PAUSED"),
      draft: completeDraft(),
    });

    const result = await state.registrar.handler.handle(context("02"));

    expect(result.ok && result.value.outgoing[0]?.payload.text).toContain(
      "📋 FICHA PRONTA PARA REVISÃO",
    );
    expect(state.checkpoints[0]).toMatchObject({ state: "REVIEW" });
  });

  it("reports SUBMITTED status instead of opening a new editor", async () => {
    const state = harness({
      conversation: conversation(PLAYER_ID, "SUBMITTED"),
      draft: completeDraft(),
      review: revision("SUBMITTED"),
    });

    const result = await state.registrar.handler.handle(context("03"));

    expect(result.ok && result.value.outgoing[0]?.payload.text).toMatch(/análise|analise/i);
    expect(result.ok && result.value.outgoing[0]?.payload.text).not.toContain(
      "Escolha como prefere",
    );
    expect(state.checkpoints.at(-1)).toMatchObject({
      state: "SUBMITTED",
      activePromptOutboxIdempotencyKey: null,
    });
  });

  it("reports an approved registration as complete instead of restarting", async () => {
    const state = harness({
      conversation: conversation(PLAYER_ID, "SUBMITTED"),
      draft: completeDraft(),
      review: revision("APPROVED"),
    });

    const result = await state.registrar.handler.handle(context("04"));

    expect(result.ok && result.value.outgoing[0]?.payload.text).toMatch(/aprovad|conclu/i);
    expect(result.ok && result.value.outgoing[0]?.payload.text).not.toContain(
      "Escolha como prefere",
    );
  });
});
