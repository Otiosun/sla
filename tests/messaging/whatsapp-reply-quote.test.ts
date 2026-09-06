import { describe, expect, it, vi } from "vitest";
import {
  BaileysWhatsAppAdapter,
  type BaileysAuthBinding,
  type BaileysEventSource,
  type BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";

class QuoteSocket implements BaileysSocketLike {
  readonly ev: BaileysEventSource = { on: () => {} };
  readonly sendMessage = vi.fn(
    async (
      _jid: string,
      _content: { readonly text: string },
      options?: Readonly<Record<string, unknown>>,
    ): Promise<unknown> => ({ key: { id: options?.messageId ?? null } }),
  );

  end(): void {}
}

function authBinding(): BaileysAuthBinding {
  return { state: {}, saveCredentials: async () => {} };
}

function outbox(payload: Readonly<Record<string, unknown>>): PendingOutboxMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "whatsapp",
    destinationRef: "120363429277815192@g.us",
    messageType: "TEXT",
    payload,
    idempotencyKey: "registration:reply:age",
    correlationId: "22222222-2222-4222-8222-222222222222",
    causationId: null,
    attempts: 0,
  };
}

describe("durable WhatsApp outbound reply context", () => {
  it("maps persisted reply context to a Baileys quoted message", async () => {
    const socket = new QuoteSocket();
    const adapter = new BaileysWhatsAppAdapter({ auth: authBinding(), socketFactory: () => socket });
    await adapter.start(async () => {});

    await adapter.send(
      outbox({
        text: "✅ Idade: 19",
        replyTo: {
          externalMessageId: "3EB0-INBOUND-AGE",
          senderRef: "120572650455159@lid",
          text: "19",
        },
      }),
    );

    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).toHaveBeenCalledWith(
      "120363429277815192@g.us",
      { text: "✅ Idade: 19" },
      {
        messageId: "11111111111141118111111111111111",
        quoted: {
          key: {
            remoteJid: "120363429277815192@g.us",
            id: "3EB0-INBOUND-AGE",
            participant: "120572650455159@lid",
            fromMe: false,
          },
          message: { conversation: "19" },
        },
      },
    );

    await adapter.stop();
  });

  it("preserves the existing provider send shape when reply context is absent", async () => {
    const socket = new QuoteSocket();
    const adapter = new BaileysWhatsAppAdapter({ auth: authBinding(), socketFactory: () => socket });
    await adapter.start(async () => {});

    await adapter.send(outbox({ text: "Olá" }));

    expect(socket.sendMessage).toHaveBeenCalledWith(
      "120363429277815192@g.us",
      { text: "Olá" },
      { messageId: "11111111111141118111111111111111" },
    );

    await adapter.stop();
  });

  it("fails delivery when persisted reply context is malformed", async () => {
    const socket = new QuoteSocket();
    const adapter = new BaileysWhatsAppAdapter({ auth: authBinding(), socketFactory: () => socket });
    await adapter.start(async () => {});

    await expect(
      adapter.send(
        outbox({
          text: "Resposta",
          replyTo: { externalMessageId: "", senderRef: "120572650455159@lid", text: "19" },
        }),
      ),
    ).rejects.toThrow();
    expect(socket.sendMessage).not.toHaveBeenCalled();

    await adapter.stop();
  });
});
