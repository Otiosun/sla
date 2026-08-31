import { describe, expect, it, vi } from "vitest";
import type {
  BaileysEventSourceLike,
  BaileysSocketConfigLike,
  BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import type { BaileysAuthSnapshot } from "../../src/adapters/whatsapp/postgres-baileys-auth.js";
import { runWhatsAppPairingBootstrap } from "../../src/operations/whatsapp-pairing-bootstrap.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);
const PATCHED_RC14 = {
  version: "7.0.0-rc14",
  pairingCompatibility: "rc14-companion-reg-refresh-v1",
} as const;

class FakePairingSocket implements BaileysSocketLike {
  ended = false;
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  readonly ev: BaileysEventSourceLike = {
    on: (event, listener) => {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener as (value: unknown) => void);
      this.listeners.set(event, listeners);
    },
  };

  async sendMessage(): Promise<unknown> {
    return {};
  }

  end(): void {
    this.ended = true;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function coreConfig() {
  return {
    appEnv: "staging" as const,
    sessionKey: "pokemon-staging",
    authEncryptionKey: AUTH_KEY,
    authEncryptionKeyVersion: 1,
    deploymentRevision: REVISION,
    timeoutMs: 1_000,
  };
}

function fakeReservation() {
  return {
    commit: vi.fn(async (_snapshot: BaileysAuthSnapshot) => {}),
    close: vi.fn(async () => {}),
  };
}

describe("WhatsApp first-pairing restart-required flow", () => {
  it("recreates the socket with the same ephemeral auth after a registered 515 restart", async () => {
    const first = new FakePairingSocket();
    const second = new FakePairingSocket();
    const sockets = [first, second];
    const socketConfigs: BaileysSocketConfigLike[] = [];
    const reservation = fakeReservation();
    let socketIndex = 0;

    const socketFactory = vi.fn((config: BaileysSocketConfigLike) => {
      socketConfigs.push(config);
      const socket = sockets[socketIndex];
      socketIndex += 1;
      if (socket === undefined) throw new Error("unexpected third pairing socket");
      return socket;
    });

    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerIdentity: PATCHED_RC14,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory,
      qrSink: { render: vi.fn(async () => {}) },
    });
    const result = pairing.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(1));
    first.emit("creds.update", { registered: true, me: { id: "paired-user" } });
    first.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    expect(socketConfigs[1]?.auth).toBe(socketConfigs[0]?.auth);
    expect(reservation.commit).not.toHaveBeenCalled();

    second.emit("connection.update", { connection: "open" });
    expect(await result).toEqual({ ok: true });

    expect(reservation.commit).toHaveBeenCalledTimes(1);
    expect(reservation.close).toHaveBeenCalledTimes(1);
    expect(first.ended).toBe(true);
    expect(second.ended).toBe(true);
  });
});
