import { describe, expect, it, vi } from "vitest";
import type { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import type {
  BaileysEventSource,
  BaileysSocketFactory,
  BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import { BaileysWhatsAppAdapter } from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";

class OrderingSocket implements BaileysSocketLike {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  readonly ev: BaileysEventSource = {
    on: (event, listener) => {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener as (value: unknown) => void);
      this.listeners.set(event, listeners);
    },
  };

  async sendMessage(
    _jid: string,
    _content: { readonly text: string },
    options?: { readonly messageId?: string },
  ): Promise<unknown> {
    return { key: { id: options?.messageId ?? null } };
  }

  end(): void {}

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function providerMessage(id: string): Parameters<typeof normalizeBaileysMessage>[0] {
  return {
    key: {
      id,
      remoteJid: "120363000000000000@g.us",
      participant: "5511999999999@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1_700_000_000,
    message: { conversation: "pikachu" },
  };
}

describe("Baileys inbound ordering", () => {
  it("serializes separate messages.upsert events so a later answer cannot overtake an earlier one", async () => {
    const socket = new OrderingSocket();
    const factory: BaileysSocketFactory = () => socket;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const completed: string[] = [];
    const providerErrors: unknown[] = [];

    const adapter = new BaileysWhatsAppAdapter({
      auth: {
        state: {},
        saveCredentials: async () => {},
      },
      socketFactory: factory,
      onProviderError: (error) => providerErrors.push(error),
    });

    await adapter.start(async (message) => {
      started.push(message.externalMessageId);
      if (message.externalMessageId === "wamid-first") {
        await firstGate;
      }
      completed.push(message.externalMessageId);
    });

    socket.emit("messages.upsert", {
      type: "notify",
      messages: [providerMessage("wamid-first")],
    });
    await vi.waitFor(() => expect(started).toEqual(["wamid-first"]));

    socket.emit("messages.upsert", {
      type: "notify",
      messages: [providerMessage("wamid-second")],
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual(["wamid-first"]);
    expect(completed).toEqual([]);

    releaseFirst();

    await vi.waitFor(() => expect(completed).toEqual(["wamid-first", "wamid-second"]));
    expect(started).toEqual(["wamid-first", "wamid-second"]);
    expect(providerErrors).toEqual([]);

    await adapter.stop();
  });
});
