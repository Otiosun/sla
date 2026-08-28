import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BaileysWhatsAppAdapter,
  type BaileysAuthBinding,
  type BaileysEventSource,
  type BaileysSocketLike,
  type BaileysSocketFactory,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import type { IncomingMessage, PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";

class FakeBaileysSocket implements BaileysSocketLike {
  readonly sent: Array<{ jid: string; content: { readonly text: string } }> = [];
  ended = false;

  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  readonly ev: BaileysEventSource = {
    on: (event, listener) => {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener as (value: unknown) => void);
      this.listeners.set(event, listeners);
    },
  };

  async sendMessage(jid: string, content: { readonly text: string }): Promise<unknown> {
    this.sent.push({ jid, content });
    return {};
  }

  end(): void {
    this.ended = true;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function authBinding(saveCredentials = vi.fn(async () => {})): BaileysAuthBinding {
  return {
    state: {} as BaileysAuthBinding["state"],
    saveCredentials,
  };
}

function providerMessage(overrides: Readonly<Record<string, unknown>> = {}): Parameters<
  typeof normalizeBaileysMessage
>[0] {
  const base = {
    key: {
      id: "wamid-1",
      remoteJid: "120363000000000000@g.us",
      participant: "5511999999999@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1_700_000_000,
    message: { conversation: "$perfil" },
  };
  return { ...base, ...overrides } as Parameters<typeof normalizeBaileysMessage>[0];
}

function outbox(overrides: Partial<PendingOutboxMessage> = {}): PendingOutboxMessage {
  return {
    id: "outbox-1",
    channel: "whatsapp",
    destinationRef: "5511999999999@s.whatsapp.net",
    messageType: "TEXT",
    payload: { text: "Olá" },
    idempotencyKey: "outbox:1",
    correlationId: "11111111-1111-4111-8111-111111111111",
    causationId: null,
    attempts: 0,
    ...overrides,
  };
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(fullPath) : [fullPath];
    }),
  );
  return nested.flat();
}

describe("Baileys provider boundary", () => {
  it("normalizes a live group text without translating opaque WhatsApp identities", () => {
    const normalized = normalizeBaileysMessage(providerMessage());
    expect(normalized).toEqual({
      provider: "baileys",
      externalMessageId: "wamid-1",
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000000000@g.us",
      occurredAt: "2023-11-14T22:13:20.000Z",
      text: "$perfil",
      mediaRefs: [],
      replyToExternalMessageId: null,
    });
  });

  it("unwraps provider wrappers and keeps only media metadata plus reply identity", () => {
    const normalized = normalizeBaileysMessage(
      providerMessage({
        message: {
          ephemeralMessage: {
            message: {
              imageMessage: {
                caption: "Olha isso",
                mimetype: "image/jpeg",
                contextInfo: { stanzaId: "quoted-message" },
              },
            },
          },
        },
      }),
    );
    expect(normalized?.text).toBe("Olha isso");
    expect(normalized?.mediaRefs).toEqual([
      {
        providerMediaId: "wamid-1:image",
        kind: "IMAGE",
        mimeType: "image/jpeg",
        fileName: null,
      },
    ]);
    expect(normalized?.replyToExternalMessageId).toBe("quoted-message");
  });

  it("ignores own messages and unsupported content", () => {
    expect(
      normalizeBaileysMessage(
        providerMessage({ key: { id: "own", remoteJid: "chat", fromMe: true } }),
      ),
    ).toBeNull();
    expect(normalizeBaileysMessage(providerMessage({ message: { protocolMessage: {} } }))).toBeNull();
  });

  it("keeps the Baileys SDK import inside the WhatsApp adapter subtree", async () => {
    const srcRoot = path.resolve("src");
    const whatsappRoot = path.join(srcRoot, "adapters", "whatsapp");
    const offenders: string[] = [];
    for (const file of await filesBelow(srcRoot)) {
      if (!file.endsWith(".ts") || file.startsWith(whatsappRoot)) continue;
      const source = await fs.readFile(file, "utf8");
      if (source.includes("@whiskeysockets/baileys")) offenders.push(path.relative(srcRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe("BaileysWhatsAppAdapter", () => {
  it("uses hardened live-message socket options and ignores history/requestId/fromMe", async () => {
    const socket = new FakeBaileysSocket();
    let capturedConfig: Parameters<BaileysSocketFactory>[0] | null = null;
    const received: IncomingMessage[] = [];
    const factory: BaileysSocketFactory = (config) => {
      capturedConfig = config;
      return socket;
    };
    const adapter = new BaileysWhatsAppAdapter({ auth: authBinding(), socketFactory: factory });
    await adapter.start(async (message) => {
      received.push(message);
    });

    expect(capturedConfig?.markOnlineOnConnect).toBe(false);
    expect(capturedConfig?.syncFullHistory).toBe(false);
    expect(capturedConfig?.shouldSyncHistoryMessage({} as never)).toBe(false);

    socket.emit("messages.upsert", {
      type: "append",
      messages: [providerMessage()],
    });
    socket.emit("messages.upsert", {
      type: "notify",
      requestId: "history-request",
      messages: [providerMessage()],
    });
    socket.emit("messages.upsert", {
      type: "notify",
      messages: [
        providerMessage({ key: { id: "own", remoteJid: "chat", fromMe: true } }),
        providerMessage(),
      ],
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.externalMessageId).toBe("wamid-1");
    await adapter.stop();
  });

  it("persists credential updates and surfaces QR through injected operational callbacks", async () => {
    const socket = new FakeBaileysSocket();
    const saveCredentials = vi.fn(async () => {});
    const onQr = vi.fn(async () => {});
    const adapter = new BaileysWhatsAppAdapter({
      auth: authBinding(saveCredentials),
      socketFactory: () => socket,
      onQr,
    });
    await adapter.start(async () => {});

    socket.emit("creds.update", {});
    socket.emit("connection.update", { qr: "qr-secret", connection: "connecting" });
    await vi.waitFor(() => expect(saveCredentials).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onQr).toHaveBeenCalledWith("qr-secret"));
    await adapter.stop();
  });

  it("maps only validated TEXT outbox messages to provider sendMessage", async () => {
    const socket = new FakeBaileysSocket();
    const adapter = new BaileysWhatsAppAdapter({ auth: authBinding(), socketFactory: () => socket });
    await adapter.start(async () => {});

    await adapter.send(outbox());
    expect(socket.sent).toEqual([
      { jid: "5511999999999@s.whatsapp.net", content: { text: "Olá" } },
    ]);
    await expect(adapter.send(outbox({ messageType: "IMAGE" }))).rejects.toThrow(
      "Unsupported Baileys outbound message type",
    );
    await expect(adapter.send(outbox({ payload: { text: 123 } }))).rejects.toThrow(
      "requires non-empty text",
    );
    await adapter.stop();
  });

  it("reconnects transient disconnects but never reconnects logged-out or stopped sessions", async () => {
    const sockets: FakeBaileysSocket[] = [];
    const onLoggedOut = vi.fn(async () => {});
    const factory: BaileysSocketFactory = () => {
      const socket = new FakeBaileysSocket();
      sockets.push(socket);
      return socket;
    };
    const adapter = new BaileysWhatsAppAdapter({
      auth: authBinding(),
      socketFactory: factory,
      reconnectDelayMs: 0,
      onLoggedOut,
    });
    await adapter.start(async () => {});
    expect(sockets).toHaveLength(1);

    sockets[0]?.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } }, date: new Date() },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    sockets[1]?.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } }, date: new Date() },
    });
    await vi.waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);

    await adapter.stop();
    expect(sockets[1]?.ended).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);
  });
});
