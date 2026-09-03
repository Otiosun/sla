import { describe, expect, it } from "vitest";
import { ReceptionAwareConversationResolver } from "../../src/modules/community/reception-conversation-resolver.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../../src/modules/messaging/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();

function message(text: string): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId: `message:${text}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: "120363000000000001@g.us",
    occurredAt: "2026-09-03T19:00:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  };
}

function context(text: string): MessageHandlerContext {
  return {
    inboxMessageId: "11111111-1111-4111-8111-111111111111",
    correlationId: "22222222-2222-4222-8222-222222222222",
    causationId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: `inbox:baileys:${text}`,
    message: message(text),
  };
}

function registrationResult(): MessageHandlerResult {
  return {
    resultRefType: "REGISTRATION_SESSION",
    resultRefId: PLAYER_ID,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: "120363000000000001@g.us",
        messageType: "TEXT",
        payload: { text: "próximo campo" },
        idempotencyKey: "registration:reply",
      },
    ],
  };
}

describe("ReceptionAwareConversationResolver", () => {
  it("gives an active registration conversation strict priority over Reception welcome", async () => {
    const expected = registrationResult();
    const resolver = new ReceptionAwareConversationResolver({
      registration: {
        admits: async () => true,
        resolve: async () => ok(expected),
      },
      reception: {
        admitsFirstInteraction: async () => {
          throw new Error("Reception admission must not run when registration owns the message");
        },
        firstInteraction: async () => {
          throw new Error("Reception welcome must not run when registration owns the message");
        },
      },
    });

    expect(await resolver.admits(message("Liora"))).toBe(true);
    expect(await resolver.resolve(context("Liora"))).toEqual(ok(expected));
  });

  it("falls back to the first state-aware Reception welcome when no registration session consumes text", async () => {
    const resolver = new ReceptionAwareConversationResolver({
      registration: {
        admits: async () => false,
        resolve: async () => ok(null),
      },
      reception: {
        admitsFirstInteraction: async (input) => {
          expect(input).toEqual({
            provider: "baileys",
            chatRef: "120363000000000001@g.us",
            externalId: "5511999999999@s.whatsapp.net",
          });
          return true;
        },
        firstInteraction: async () =>
          ok({
            playerId: PLAYER_ID,
            text: "🎒 Bem-vindo à Recepção. Use `$registrar` para começar.",
          }),
      },
    });

    expect(await resolver.admits(message("oi"))).toBe(true);
    expect(await resolver.resolve(context("oi"))).toMatchObject({
      ok: true,
      value: {
        resultRefType: "RECEPTION_WELCOME",
        resultRefId: PLAYER_ID,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: "120363000000000001@g.us",
            messageType: "TEXT",
            payload: { text: expect.stringMatching(/\$registrar/i) },
            idempotencyKey: "inbox:baileys:oi:reception-welcome",
          },
        ],
      },
    });
  });

  it("does not admit ordinary Reception chatter once neither flow needs it", async () => {
    const resolver = new ReceptionAwareConversationResolver({
      registration: {
        admits: async () => false,
        resolve: async () => ok(null),
      },
      reception: {
        admitsFirstInteraction: async () => false,
        firstInteraction: async () => ok(null),
      },
    });

    expect(await resolver.admits(message("conversa normal"))).toBe(false);
  });
});
