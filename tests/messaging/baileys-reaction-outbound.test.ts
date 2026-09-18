import { describe, expect, it, vi } from "vitest";
import {
  BaileysWhatsAppAdapter,
  baileysOutboundMessageId,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";

describe("Baileys outbound reaction", () => {
  it("reacts to the exact incoming WhatsApp message with the accepted-action check", async () => {
    const sendMessage = vi.fn(
      async (_jid: string, _content: unknown, options?: { readonly messageId?: string }) => ({
        key: { id: options?.messageId },
      }),
    );
    const socket = {
      ev: { on: vi.fn() },
      sendMessage,
      end: vi.fn(),
    } as never;
    const adapter = new BaileysWhatsAppAdapter({
      auth: { state: {}, saveCredentials: vi.fn(async () => undefined) },
      socketFactory: () => socket,
    });
    await adapter.start(async () => undefined);

    const message: PendingOutboxMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      channel: "whatsapp",
      destinationRef: "999@g.us",
      messageType: "REACTION",
      payload: {
        emoji: "✅",
        targetExternalMessageId: "ABC123",
        targetSenderRef: "5511999999999@s.whatsapp.net",
      },
      idempotencyKey: "reaction",
      correlationId: "22222222-2222-4222-8222-222222222222",
      causationId: null,
      attempts: 1,
    };

    await adapter.send(message);

    expect(sendMessage).toHaveBeenCalledWith(
      "999@g.us",
      {
        react: {
          text: "✅",
          key: {
            remoteJid: "999@g.us",
            id: "ABC123",
            participant: "5511999999999@s.whatsapp.net",
          },
        },
      },
      { messageId: baileysOutboundMessageId(message) },
    );

    await adapter.stop();
  });
});
