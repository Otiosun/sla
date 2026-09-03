import { describe, expect, it } from "vitest";
import { RegistrationConversationSessions } from "../../src/modules/registration/conversation-session.js";
import { withRegistrationReviewMentions } from "../../src/modules/registration/review-notification-mentions.js";
import { createRegistrationWhatsAppRoutes } from "../../src/modules/registration/whatsapp-handlers.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
const CHAT_REF = "120363000000000001@g.us";
const STAFF_JIDS = ["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"] as const;

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "44444444-4444-4444-8444-444444444444",
    correlationId: "55555555-5555-4555-8555-555555555555",
    causationId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: `inbox:baileys:${text}`,
    message: {
      provider: "baileys",
      externalMessageId: `message:${text}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: CHAT_REF,
      occurredAt: "2026-09-02T16:40:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function completedDraft() {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: STARTER_ID,
    regionId: REGION_ID,
    schemaVersion: 1,
  } as const;
}

describe("registration review notification", () => {
  it("enriches the durable reply anchor with real valid staff mentions after submission", async () => {
    const sessions = new RegistrationConversationSessions();
    sessions.start(PLAYER_ID, {
      mode: "FULL",
      regionId: REGION_ID,
      baseDraft: completedDraft(),
      baseRevision: 4,
    });

    const baseRoutes = createRegistrationWhatsAppRoutes({
      sessions,
      players: {
        resolveOrCreatePlayer: async () =>
          ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
        resolvePlayer: async () =>
          ok({ playerId: PLAYER_ID, state: "NEW" as const, created: false }),
      },
      registration: {
        getDraft: async () => err(appError("NOT_FOUND", "draft not needed")),
        getCurrentReview: async () => err(appError("NOT_FOUND", "review not needed")),
        saveDraft: async () => err(appError("ACTION_INVALID", "save not needed")),
        saveAndSubmit: async (input) =>
          ok({
            id: REVIEW_ID,
            playerId: input.playerId,
            sequenceNo: 2,
            status: "SUBMITTED" as const,
            snapshot: completedDraft(),
            revision: 0,
            replayed: false,
          }),
        withdraw: async () => err(appError("ACTION_INVALID", "withdraw not needed")),
      },
      setup: {
        load: async () =>
          ok({
            regionId: REGION_ID,
            regionDisplayName: "Zhoulia",
            starterOptions: [{ formId: STARTER_ID, displayName: "Charmander" }],
          }),
      },
    });
    const routes = withRegistrationReviewMentions(baseRoutes, {
      mentionsFor: async (input: { readonly provider: string; readonly chatRef: string }) => {
        expect(input).toEqual({ provider: "baileys", chatRef: CHAT_REF });
        return STAFF_JIDS;
      },
    });
    const confirm = routes.find((candidate) => candidate.command === "confirmar");
    if (confirm === undefined) throw new Error("Missing confirmar route");

    expect(await confirm.handler.handle(context("$confirmar"))).toMatchObject({ ok: true });
    const submitted = await confirm.handler.handle(context("$confirmar sim"));

    expect(submitted).toMatchObject({
      ok: true,
      value: {
        outgoing: [
          { payload: { text: expect.stringMatching(/enviada.*análise/i) } },
          {
            channel: "whatsapp",
            destinationRef: CHAT_REF,
            messageType: "TEXT",
            payload: {
              text: expect.stringMatching(
                /nova ficha.*Liora Vale.*revisão[\s\S]*@5511888888888.*@5511999999999/i,
              ),
              mentions: STAFF_JIDS,
              registrationReview: { reviewId: REVIEW_ID, reviewRevision: 0 },
            },
            idempotencyKey: `registration-review-notification:${REVIEW_ID}:0`,
          },
        ],
      },
    });
  });
});
