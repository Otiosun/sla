import { describe, expect, it } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { ok } from "../../src/shared-kernel/result.js";
import { withRegistrationReviewConversationMentions } from "../../src/modules/registration/review-notification-mentions.js";

const CHAT_REF = "120363000000000001@g.us";

function message(): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: "player-review-choice",
    senderRef: "5511777777777@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-06T16:20:00.000-03:00",
    text: "1",
    mediaRefs: [],
    replyToExternalMessageId: "bot-review-prompt",
  };
}

function context(): MessageHandlerContext {
  return {
    inboxMessageId: "11111111-1111-4111-8111-111111111111",
    correlationId: "22222222-2222-4222-8222-222222222222",
    causationId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "inbox:baileys:player-review-choice",
    message: message(),
  };
}

describe("Registration review mentions on conversation submission", () => {
  it("decorates registrationReview outgoing created by freeform REVIEW choice 1", async () => {
    const conversation = withRegistrationReviewConversationMentions(
      {
        admits: async () => true,
        resolve: async () =>
          ok({
            resultRefType: "REGISTRATION_SESSION",
            resultRefId: "33333333-3333-4333-8333-333333333333",
            outgoing: [
              {
                channel: "whatsapp",
                destinationRef: CHAT_REF,
                messageType: "TEXT",
                payload: { text: "📨 Ficha enviada." },
                idempotencyKey: "player-confirmation",
              },
              {
                channel: "whatsapp",
                destinationRef: CHAT_REF,
                messageType: "TEXT",
                payload: {
                  text: "📋 Nova ficha aguardando revisão.",
                  registrationReview: {
                    reviewId: "44444444-4444-4444-8444-444444444444",
                    reviewRevision: 0,
                  },
                },
                idempotencyKey: "review-notification",
              },
            ],
          }),
      },
      {
        mentionsFor: async () => ["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"],
      },
    );

    await expect(conversation.admits(message())).resolves.toBe(true);
    const result = await conversation.resolve(context());

    expect(result.ok && result.value?.outgoing[0]?.payload).toEqual({ text: "📨 Ficha enviada." });
    expect(result.ok && result.value?.outgoing[1]?.payload).toMatchObject({
      text: "📋 Nova ficha aguardando revisão.\n\nResponsáveis: @5511888888888 @5511999999999",
      mentions: ["5511888888888@s.whatsapp.net", "5511999999999@s.whatsapp.net"],
    });
  });
});
