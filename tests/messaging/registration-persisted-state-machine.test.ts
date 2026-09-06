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
const CURRENT_PROMPT_ID = "BOT-CURRENT-PROMPT";
const OLD_PROMPT_ID = "BOT-OLD-PROMPT";
const HUMAN_MESSAGE_ID = "HUMAN-MESSAGE";
const ACTIVE_KEY = "registration:active-prompt";

type ReplyIntentInput = Parameters<RegistrationReplyIntentVerifier["isExpectedReply"]>[0];

function messageContext(
  text: string,
  replyToExternalMessageId: string | null = null,
  suffix = "01",
): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000001${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000002${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000001${suffix}`,
    idempotencyKey: `inbox:baileys:registration-persisted-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `registration-persisted-${suffix}`,
      senderRef: PLAYER_REF,
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T02:50:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId,
    },
  };
}

function conversation(
  playerId: PlayerId,
  input: Partial<RegistrationConversationRecord> = {},
): RegistrationConversationRecord {
  return {
    playerId,
    chatRef: CHAT_REF,
    state: "MODE_SELECT",
    editingMode: null,
    currentField: null,
    editField: null,
    activePromptOutboxIdempotencyKey: ACTIVE_KEY,
    draftRevision: null,
    lastInboxMessageId: null,
    flowVersion: 2,
    revision: 4,
    ...input,
  };
}

function completeDraft(starterFormId = CHARMANDER_ID): RegistrationDraftInput {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId,
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
      isExpectedReply: async (input: ReplyIntentInput) =>
        input.expectedOutboxIdempotencyKey === ACTIVE_KEY &&
        input.replyToExternalMessageId === CURRENT_PROMPT_ID,
    },
  } as never);

  return {
    resolver,
    checkpoints,
    getConversation: () => currentConversation,
    getDraft: () => currentDraft,
  };
}

describe("persisted Registration conversation state machine", () => {
  it("admits only a reply to the exact persisted active prompt", async () => {
    const playerId = createPlayerId();
    const { resolver } = harness({ initialConversation: conversation(playerId) });

    await expect(resolver.admits(messageContext("1").message)).resolves.toBe(false);
    await expect(
      resolver.admits(messageContext("1", HUMAN_MESSAGE_ID, "02").message),
    ).resolves.toBe(false);
    await expect(resolver.admits(messageContext("1", OLD_PROMPT_ID, "03").message)).resolves.toBe(
      false,
    );
    await expect(
      resolver.admits(messageContext("1", CURRENT_PROMPT_ID, "04").message),
    ).resolves.toBe(true);
  });

  it("persists guided mode and the next active prompt before returning the response", async () => {
    const playerId = createPlayerId();
    const state = harness({ initialConversation: conversation(playerId) });
    const router = new MessageRouter([], undefined, state.resolver);
    const context = messageContext("1", CURRENT_PROMPT_ID, "05");

    const routed = await router.dispatch(context);

    expect(routed).toMatchObject({
      ok: true,
      value: {
        resultRefType: "REGISTRATION_SESSION",
        resultRefId: playerId,
        outgoing: [
          {
            payload: {
              text: expect.stringContaining("✅ Modo guiado escolhido."),
              replyTo: {
                externalMessageId: context.message.externalMessageId,
                senderRef: PLAYER_REF,
                text: "1",
              },
            },
          },
        ],
      },
    });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "📝 1/7 — Nome do treinador",
    );
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]).toMatchObject({
      state: "GUIDED_FIELD",
      editingMode: "GUIDED",
      currentField: "trainerName",
      inboxMessageId: context.inboxMessageId,
      activePromptOutboxIdempotencyKey: `${context.idempotencyKey}:registration-conversation`,
      expectedConversationRevision: 4,
      expectedDraftRevision: null,
    });
  });

  it("autosaves a guided answer and advances the persisted field before responding", async () => {
    const playerId = createPlayerId();
    const state = harness({
      initialConversation: conversation(playerId, {
        state: "GUIDED_FIELD",
        editingMode: "GUIDED",
        currentField: "trainerName",
      }),
    });
    const router = new MessageRouter([], undefined, state.resolver);
    const context = messageContext("Liora Vale", CURRENT_PROMPT_ID, "06");

    const routed = await router.dispatch(context);

    expect(routed.ok).toBe(true);
    expect(state.checkpoints[0]).toMatchObject({
      state: "GUIDED_FIELD",
      editingMode: "GUIDED",
      currentField: "age",
      draft: {
        trainerName: "Liora Vale",
        regionId: ZHOULIA_ID,
        schemaVersion: 1,
      },
    });
    expect(state.getDraft()).toMatchObject({ trainerName: "Liora Vale" });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "✅ 1/7 — Nome: Liora Vale",
    );
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("📝 2/7 — Idade");
  });

  it("moves the final guided starter directly to REVIEW with the canonical starter", async () => {
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
    const context = messageContext("Charmander", CURRENT_PROMPT_ID, "07");

    const routed = await router.dispatch(context);

    expect(state.checkpoints[0]).toMatchObject({
      state: "REVIEW",
      editingMode: "GUIDED",
      currentField: null,
      draft: { starterFormId: CHARMANDER_ID },
    });
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "✅ 7/7 — Pokémon inicial: Charmander",
    );
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain(
      "📋 FICHA PRONTA PARA REVISÃO",
    );
  });

  it("keeps an invalid full form in FULL_FORM and makes the retry the new active prompt", async () => {
    const playerId = createPlayerId();
    const state = harness({
      initialConversation: conversation(playerId, {
        state: "FULL_FORM",
        editingMode: "FULL",
      }),
    });
    const router = new MessageRouter([], undefined, state.resolver);
    const context = messageContext("Nome: Liora Vale\nIdade: não sei", CURRENT_PROMPT_ID, "08");

    const routed = await router.dispatch(context);

    expect(routed.ok).toBe(true);
    expect(state.checkpoints[0]).toMatchObject({
      state: "FULL_FORM",
      editingMode: "FULL",
      currentField: null,
      activePromptOutboxIdempotencyKey: `${context.idempotencyKey}:registration-conversation`,
    });
    expect(state.checkpoints[0]).not.toHaveProperty("draft");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("⚠️");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).toContain("📋 FICHA COMPLETA");
    expect(routed.ok && routed.value?.outgoing[0]?.payload.text).not.toContain("correlation");
  });
});
