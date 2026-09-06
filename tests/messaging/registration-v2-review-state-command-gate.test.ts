import { describe, expect, it } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { RegistrationConversationRecord } from "../../src/modules/registration/conversation-state.js";
import type { RegistrationRevisionRecord } from "../../src/modules/registration/ports.js";
import { createRegistrationWhatsAppRoutesV2 } from "../../src/modules/registration/whatsapp-handlers-v2.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const ZHOULIA_ID = "11111111-1111-4111-8111-111111111111";
const CHARMANDER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_REF = "120363000000000001@g.us";

function draft() {
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
  } as const;
}

function conversation(): RegistrationConversationRecord {
  return {
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
    revision: 7,
  };
}

function submittedReview(): RegistrationRevisionRecord {
  return {
    id: REVIEW_ID,
    playerId: PLAYER_ID,
    sequenceNo: 1,
    status: "SUBMITTED",
    snapshot: draft(),
    revision: 0,
  };
}

function context(text: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000010${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000011${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000010${suffix}`,
    idempotencyKey: `inbox:baileys:review-lock-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `review-lock-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: CHAT_REF,
      occurredAt: "2026-09-06T17:10:00.000-03:00",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function harness() {
  const checkpoints: Array<Record<string, unknown>> = [];
  let submitCalls = 0;
  let withdrawCalls = 0;
  let resetCalls = 0;

  const routes = createRegistrationWhatsAppRoutesV2({
    players: {
      resolveOrCreatePlayer: async () =>
        ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
    },
    registration: {
      getDraft: async () => ok({ playerId: PLAYER_ID, snapshot: draft(), revision: 2 }),
      getCurrentReview: async () => ok(submittedReview()),
      getConversation: async () => ok(conversation()),
      saveConversationCheckpoint: async (input: Record<string, unknown>) => {
        checkpoints.push(input);
        return err(appError("ACTION_INVALID", "submitted review must not change conversation state"));
      },
      submit: async () => {
        submitCalls += 1;
        return err(appError("ACTION_INVALID", "submitted review must not submit twice"));
      },
      withdraw: async () => {
        withdrawCalls += 1;
        return err(appError("ACTION_INVALID", "withdraw is only valid through explicit edit flow"));
      },
      resetMutableRegistration: async () => {
        resetCalls += 1;
        return err(appError("ACTION_INVALID", "submitted review must not reset mutable progress"));
      },
    },
    setup: {
      load: async () =>
        ok({
          regionId: ZHOULIA_ID,
          regionDisplayName: "Zhoulia",
          starterOptions: [{ formId: CHARMANDER_ID, displayName: "Charmander" }],
        }),
    },
  } as never);

  return {
    routes,
    checkpoints,
    submitCalls: () => submitCalls,
    withdrawCalls: () => withdrawCalls,
    resetCalls: () => resetCalls,
  };
}

function route(
  routes: ReturnType<typeof createRegistrationWhatsAppRoutesV2>,
  command: string,
) {
  const found = routes.find((candidate) => candidate.command === command);
  if (found === undefined) throw new Error(`Missing v2 registration route ${command}`);
  return found;
}

describe("v2 compatibility aliases while a registration review is submitted", () => {
  for (const [command, text] of [
    ["modo", "$modo completo"],
    ["ficha", "$ficha"],
    ["salvar", "$salvar"],
    ["continuar", "$continuar"],
    ["confirmar", "$confirmar"],
  ] as const) {
    it(`${command} reports the pending review without reopening mutable conversation state`, async () => {
      const state = harness();
      const result = await route(state.routes, command).handler.handle(context(text, command));

      expect(result).toMatchObject({
        ok: true,
        value: {
          resultRefType: "REGISTRATION_SESSION",
          resultRefId: PLAYER_ID,
          outgoing: [
            {
              payload: {
                text: expect.stringMatching(/enviada.*análise|análise.*equipe/i),
              },
            },
          ],
        },
      });
      expect(result.ok && result.value.outgoing[0]?.payload.text).not.toMatch(
        /FICHA COMPLETA|FICHA PRONTA PARA REVISÃO|Escolha como prefere|O que deseja corrigir/i,
      );
      expect(state.checkpoints).toEqual([]);
      expect(state.submitCalls()).toBe(0);
      expect(state.withdrawCalls()).toBe(0);
      expect(state.resetCalls()).toBe(0);
    });
  }
});
