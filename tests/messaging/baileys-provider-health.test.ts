import { describe, expect, it, vi } from "vitest";
import {
  BaileysWhatsAppAdapter,
  type BaileysAuthBinding,
  type BaileysEventSource,
  type BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";

class HealthTestSocket implements BaileysSocketLike {
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
    async saveCredentials() {},
  };
}

describe("Baileys provider health transitions", () => {
  it("surfaces connected and disconnected transitions through the operational callback", async () => {
    const socket = new HealthTestSocket();
    const onConnectionState = vi.fn(async () => {});
    const adapter = new BaileysWhatsAppAdapter({
      auth: authBinding(),
      socketFactory: () => socket,
      reconnectDelayMs: 50,
      onConnectionState,
    });

    await adapter.start(async () => {});
    socket.emit("connection.update", { connection: "open" });
    await vi.waitFor(() => expect(onConnectionState).toHaveBeenCalledWith("CONNECTED"));

    socket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } }, date: new Date() },
    });
    await vi.waitFor(() => expect(onConnectionState).toHaveBeenCalledWith("DISCONNECTED"));

    expect(onConnectionState.mock.calls.map(([state]) => state)).toEqual([
      "CONNECTED",
      "DISCONNECTED",
    ]);
    await adapter.stop();
  });

  it("does not let an operational health callback failure suppress provider reconnect", async () => {
    const sockets: HealthTestSocket[] = [];
    const onProviderError = vi.fn();
    const adapter = new BaileysWhatsAppAdapter({
      auth: authBinding(),
      socketFactory: () => {
        const socket = new HealthTestSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 0,
      onConnectionState: async (state) => {
        if (state === "DISCONNECTED") throw new Error("health persistence unavailable");
      },
      onProviderError,
    });

    await adapter.start(async () => {});
    const firstSocket = sockets[0];
    if (firstSocket === undefined) throw new Error("expected first socket");

    firstSocket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } }, date: new Date() },
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(onProviderError).toHaveBeenCalledTimes(1);
    expect(onProviderError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    await adapter.stop();
  });
});
