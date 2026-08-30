import { describe, expect, it, vi } from "vitest";
import type {
  BaileysEventSourceLike,
  BaileysSocketConfigLike,
  BaileysSocketLike,
  BaileysWaWebVersion,
} from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import type { BaileysAuthSnapshot } from "../../src/adapters/whatsapp/postgres-baileys-auth.js";
import {
  loadWhatsAppPairingBootstrapConfig,
  WhatsAppPairingBootstrapConfigError,
} from "../../src/operations/whatsapp-pairing-bootstrap-config.js";
import {
  runWhatsAppPairingBootstrap,
  WhatsAppPairingIncompleteAuthError,
  WhatsAppPairingProviderClosedError,
  WhatsAppPairingProviderVersionBlockedError,
  WhatsAppPairingTimeoutError,
} from "../../src/operations/whatsapp-pairing-bootstrap.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);
const WA_WEB_VERSION: BaileysWaWebVersion = [2, 3000, 1042626022];

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

interface PairingAuthState {
  readonly creds: Record<string, unknown>;
  readonly keys: {
    get(type: string, ids: readonly string[]): Promise<Record<string, unknown>>;
    set(
      data: Readonly<Record<string, Readonly<Record<string, unknown | null | undefined>>>>,
    ): Promise<void>;
  };
}

function coreConfig(timeoutMs = 1_000) {
  return {
    appEnv: "staging" as const,
    sessionKey: "pokemon-staging",
    authEncryptionKey: AUTH_KEY,
    authEncryptionKeyVersion: 1,
    deploymentRevision: REVISION,
    timeoutMs,
  };
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "staging",
    DATABASE_URL: "postgresql://runtime:runtime-password@localhost:5432/pokemon_rpg",
    DEPLOY_REVISION: REVISION,
    WHATSAPP_SESSION_KEY: "pokemon-staging",
    WHATSAPP_AUTH_KEY_BASE64: AUTH_KEY.toString("base64"),
    WHATSAPP_AUTH_KEY_VERSION: "1",
    WHATSAPP_PAIRING_TIMEOUT_MS: "120000",
  };
}

function fakeReservation() {
  return {
    commit: vi.fn(async (_snapshot: BaileysAuthSnapshot) => {}),
    close: vi.fn(async () => {}),
  };
}

describe("WhatsApp pairing bootstrap config", () => {
  it("accepts a release-bound staging configuration", () => {
    const config = loadWhatsAppPairingBootstrapConfig({ appEnv: "staging" }, validEnv());
    expect(config.appEnv).toBe("staging");
    expect(config.sessionKey).toBe("pokemon-staging");
    expect(config.authEncryptionKey).toEqual(AUTH_KEY);
    expect(config.deploymentRevision).toBe(REVISION);
    expect(config.timeoutMs).toBe(120_000);
  });

  it("rejects non-release environments and malformed pairing timeout", () => {
    expect(() =>
      loadWhatsAppPairingBootstrapConfig({ appEnv: "test" }, { ...validEnv(), APP_ENV: "test" }),
    ).toThrow(WhatsAppPairingBootstrapConfigError);

    expect(() =>
      loadWhatsAppPairingBootstrapConfig(
        { appEnv: "staging" },
        { ...validEnv(), WHATSAPP_PAIRING_TIMEOUT_MS: "0" },
      ),
    ).toThrow(WhatsAppPairingBootstrapConfigError);
  });
});

describe("WhatsApp first-pairing bootstrap core", () => {
  it("blocks an unreviewed provider version before reserving auth or creating a socket", async () => {
    const reserveBootstrap = vi.fn(async () => fakeReservation());
    const socketFactory = vi.fn(() => new FakePairingSocket());

    await expect(
      runWhatsAppPairingBootstrap({
        config: coreConfig(),
        providerVersion: "7.0.0-rc15",
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap,
        socketFactory,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(reserveBootstrap).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("persists one encrypted-ready snapshot only after provider open", async () => {
    const socket = new FakePairingSocket();
    const socketConfigs: BaileysSocketConfigLike[] = [];
    const reservation = fakeReservation();
    const qrSink = { render: vi.fn(async () => {}) };
    const reserveBootstrap = vi.fn(async () => reservation);
    const socketFactory = vi.fn((config: BaileysSocketConfigLike) => {
      socketConfigs.push(config);
      return socket;
    });

    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerVersion: "7.0.0-rc14",
      waWebVersion: WA_WEB_VERSION,
      reserveBootstrap,
      socketFactory,
      qrSink,
    });

    await vi.waitFor(() => expect(socketConfigs).toHaveLength(1));
    const auth = socketConfigs[0]?.auth as PairingAuthState;
    await auth.keys.set({
      "pre-key": {
        alpha: Buffer.from([1, 2, 3, 4]),
      },
    });
    socket.emit("creds.update", { registered: true, me: { id: "paired-user" } });
    socket.emit("connection.update", { connection: "connecting", qr: "sensitive-qr" });
    await vi.waitFor(() => expect(qrSink.render).toHaveBeenCalledWith("sensitive-qr"));
    expect(reservation.commit).not.toHaveBeenCalled();

    socket.emit("connection.update", { connection: "open" });
    await pairing;

    expect(reservation.commit).toHaveBeenCalledTimes(1);
    const snapshot = reservation.commit.mock.calls[0]?.[0];
    expect(snapshot?.creds.registered).toBe(true);
    expect(snapshot?.creds.me).toEqual({ id: "paired-user" });
    expect(snapshot?.keys["pre-key"]?.alpha).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(reservation.close).toHaveBeenCalledTimes(1);
    expect(socket.ended).toBe(true);
  });

  it("fails closed on provider close without persisting auth or leaking QR", async () => {
    const socket = new FakePairingSocket();
    const reservation = fakeReservation();
    const socketFactory = vi.fn(() => socket);
    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerVersion: "7.0.0-rc14",
      waWebVersion: WA_WEB_VERSION,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory,
      qrSink: { render: vi.fn(async () => {}) },
    });

    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(1));
    socket.emit("connection.update", { connection: "connecting", qr: "never-log-this-qr" });
    socket.emit("connection.update", { connection: "close", lastDisconnect: { error: "secret" } });

    const error = await pairing.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WhatsAppPairingProviderClosedError);
    expect(String(error)).not.toContain("never-log-this-qr");
    expect(String(error)).not.toContain("secret");
    expect(reservation.commit).not.toHaveBeenCalled();
    expect(reservation.close).toHaveBeenCalledTimes(1);
    expect(socket.ended).toBe(true);
  });

  it("rejects provider open when the ephemeral credentials are not registered", async () => {
    const socket = new FakePairingSocket();
    const reservation = fakeReservation();
    const socketFactory = vi.fn(() => socket);
    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerVersion: "7.0.0-rc14",
      waWebVersion: WA_WEB_VERSION,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory,
      qrSink: { render: vi.fn(async () => {}) },
    });

    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(1));
    socket.emit("connection.update", { connection: "open" });

    await expect(pairing).rejects.toBeInstanceOf(WhatsAppPairingIncompleteAuthError);
    expect(reservation.commit).not.toHaveBeenCalled();
    expect(reservation.close).toHaveBeenCalledTimes(1);
  });

  it("times out without persisting auth and always releases the reservation", async () => {
    const socket = new FakePairingSocket();
    const reservation = fakeReservation();

    await expect(
      runWhatsAppPairingBootstrap({
        config: coreConfig(10),
        providerVersion: "7.0.0-rc14",
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap: vi.fn(async () => reservation),
        socketFactory: () => socket,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingTimeoutError);

    expect(reservation.commit).not.toHaveBeenCalled();
    expect(reservation.close).toHaveBeenCalledTimes(1);
    expect(socket.ended).toBe(true);
  });
});
