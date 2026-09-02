import { describe, expect, it } from "vitest";
import {
  BaileysWhatsAppAdapter,
  type BaileysEventSource,
  type BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";

function outbox(payload: Readonly<Record<string, unknown>>): PendingOutboxMessage {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    channel: "whatsapp",
    destinationRef: "120363000000000001@g.us",
    messageType: "TEXT",
    payload,
    idempotencyKey: "registration-review-notification",
    correlationId: "00000000-0000-4000-8000-000000000802",
    causationId: null,
    attempts: 1,
  };
}

describe("Baileys outbox mentions and provider receipt", () => {
  it("sends real mentions with a deterministic provider message id and returns that exact id", async () => {
    const sent: Array<{
      jid: string;
      content: unknown;
      options: { readonly messageId?: string } | undefined;
    }> = [];
    const events: BaileysEventSource = { on: () => {} };
    const socket: BaileysSocketLike = {
      ev: events,
      sendMessage: async (jid, content, options?: { readonly messageId?: string }) => {
        sent.push({ jid, content, options });
        return { key: { id: options?.messageId ?? "provider-generated-id" } };
      },
      end: () => {},
    };
    const adapter = new BaileysWhatsAppAdapter({
      auth: { state: {}, saveCredentials: async () => {} },
      socketFactory: () => socket,
    });
    await adapter.start(async () => {});

    const receipt = await adapter.send(
      outbox({
        text: "Nova ficha aguardando revisão. @5511999999999",
        mentions: ["5511999999999@s.whatsapp.net"],
      }),
    );

    expect(sent).toEqual([
      {
        jid: "120363000000000001@g.us",
        content: {
          text: "Nova ficha aguardando revisão. @5511999999999",
          mentions: ["5511999999999@s.whatsapp.net"],
        },
        options: { messageId: "00000000000040008000000000000801" },
      },
    ]);
    expect(receipt).toEqual({
      providerExternalMessageId: "00000000000040008000000000000801",
    });
  });
});
