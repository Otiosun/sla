import { describe, expect, it, vi } from "vitest";
import {
  BaileysWhatsAppAdapter,
  type BaileysAuthBinding,
  type BaileysEventSource,
  type BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { BaileysMessageLike } from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import type { IncomingMessage } from "../../src/modules/messaging/contracts.js";

class FakeBaileysSocket implements BaileysSocketLike {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  readonly ev: BaileysEventSource = {
    on: (event, listener) => {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener as (value: unknown) => void);
      this.listeners.set(event, listeners);
    },
  };

  async sendMessage(): Promise<unknown> {
    return {};
  }

  end(): void {}

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function authBinding(): BaileysAuthBinding {
  return {
    state: {},
    saveCredentials: async () => {},
  };
}

function providerMessage(id: string, remoteJid: string): BaileysMessageLike {
  return {
    key: {
      id,
      remoteJid,
      participant: "5511999999999@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1_700_000_000,
    message: { conversation: "$ajuda" },
  };
}

describe("Baileys malformed upsert isolation", () => {
  it("drops a schema-invalid provider message without losing a valid sibling in the same notify batch", async () => {
    const socket = new FakeBaileysSocket();
    const received: IncomingMessage[] = [];
    const onProviderError = vi.fn();
    const adapter = new BaileysWhatsAppAdapter({
      auth: authBinding(),
      socketFactory: () => socket,
      onProviderError,
    });
    await adapter.start(async (message) => {
      received.push(message);
    });

    socket.emit("messages.upsert", {
      type: "notify",
      messages: [
        providerMessage("bad", `${"x".repeat(513)}@g.us`),
        providerMessage("good", "120363000000000000@g.us"),
      ],
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.externalMessageId).toBe("good");
    expect(onProviderError).not.toHaveBeenCalled();

    await adapter.stop();
  });
});
