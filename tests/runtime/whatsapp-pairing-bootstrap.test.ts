import { describe, expect, it, vi } from "vitest";
import type {
  BaileysEventSourceLike,
  BaileysSocketConfigLike,
  BaileysSocketLike,
} from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import type { BaileysAuthSnapshot } from "../../src/adapters/whatsapp/postgres-baileys-auth.js";
import {
  runWhatsAppPairingBootstrap,
  WhatsAppPairingCodeConnectionError,
  WhatsAppPairingCodeRequestError,
  WhatsAppPairingIncompleteAuthError,
  WhatsAppPairingProviderClosedError,
  WhatsAppPairingProviderVersionBlockedError,
  WhatsAppPairingTimeoutError,
} from "../../src/operations/whatsapp-pairing-bootstrap.js";
import {
  loadWhatsAppPairingBootstrapConfig,
  WhatsAppPairingBootstrapConfigError,
} from "../../src/operations/whatsapp-pairing-bootstrap-config.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);
const PATCHED_RC14 = {
  version: "7.0.0-rc14",
  pairingCompatibility: "rc14-companion-reg-refresh-v1",
} as const;
const BARE_RC14 = {
  version: "7.0.0-rc14",
  pairingCompatibility: null,
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

  async requestPairingCode(): Promise<string> {
    return "1234-5678";
  }

  async waitForSocketOpen(): Promise<void> {}

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
    pairingMode: "qr" as const,
    pairingPhoneE164: null,
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

  it("defaults pairing mode to QR and requires a valid phone only for code mode", () => {
    expect(loadWhatsAppPairingBootstrapConfig({ appEnv: "staging" }, validEnv()).pairingMode).toBe(
      "qr",
    );
    expect(() =>
      loadWhatsAppPairingBootstrapConfig(
        { appEnv: "staging" },
        { ...validEnv(), WHATSAPP_PAIRING_MODE: "code" },
      ),
    ).toThrow(/PHONE/);
    expect(() =>
      loadWhatsAppPairingBootstrapConfig(
        { appEnv: "staging" },
        { ...validEnv(), WHATSAPP_PAIRING_MODE: "code", WHATSAPP_PAIRING_PHONE_E164: "abc" },
      ),
    ).toThrow(/E\.164/);
  });
});

describe("WhatsApp first-pairing bootstrap core", () => {
  it("blocks bare rc14 before reserving auth or creating a socket", async () => {
    const reserveBootstrap = vi.fn(async () => fakeReservation());
    const socketFactory = vi.fn(() => new FakePairingSocket());

    await expect(
      runWhatsAppPairingBootstrap({
        config: coreConfig(),
        providerIdentity: BARE_RC14,
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
      providerIdentity: PATCHED_RC14,
      reserveBootstrap,
      socketFactory,
      qrSink,
    });

    await vi.waitFor(() => expect(socketConfigs).toHaveLength(1));
    expect(socketConfigs[0]?.browser).toEqual(["Ubuntu", "Chrome", "22.04.4"]);
    expect(socketConfigs[0]?.browser).not.toContain("Windows");
    expect(socketConfigs[0]?.browser).not.toContain("Mac OS");
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

  it("requests one pairing code without rendering QR and persists through the existing snapshot flow", async () => {
    const socket = new FakePairingSocket();
    const requestPairingCode = vi.spyOn(socket, "requestPairingCode");
    const reservation = fakeReservation();
    const qrSink = { render: vi.fn(async () => {}) };
    const codeSink = { render: vi.fn(async () => {}) };
    const pairing = runWhatsAppPairingBootstrap({
      config: {
        ...coreConfig(),
        pairingMode: "code",
        pairingPhoneE164: "5511999999999",
      },
      providerIdentity: PATCHED_RC14,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory: () => socket,
      qrSink,
      codeSink,
    });

    await vi.waitFor(() => expect(requestPairingCode).toHaveBeenCalledTimes(1));
    expect(requestPairingCode).toHaveBeenCalledWith("5511999999999");
    await vi.waitFor(() => expect(codeSink.render).toHaveBeenCalledWith("1234-5678"));
    expect(qrSink.render).not.toHaveBeenCalled();
    socket.emit("creds.update", { registered: true, me: { id: "paired-user" } });
    socket.emit("connection.update", { connection: "open" });
    await pairing;
    expect(reservation.commit).toHaveBeenCalledTimes(1);
  });

  it("preserves a redacted pairing-code provider error and leaves the reservation uncommitted", async () => {
    const socket = new FakePairingSocket();
    const requestError = Object.assign(
      new Error("request failed for 5511999999999 code 1234-5678"),
      {
        output: { statusCode: 428 },
      },
    );
    vi.spyOn(socket, "requestPairingCode").mockRejectedValue(requestError);
    const reservation = fakeReservation();

    const error = await runWhatsAppPairingBootstrap({
      config: { ...coreConfig(), pairingMode: "code", pairingPhoneE164: "5511999999999" },
      providerIdentity: PATCHED_RC14,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory: () => socket,
      qrSink: { render: vi.fn(async () => {}) },
      codeSink: { render: vi.fn(async () => {}) },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WhatsAppPairingCodeRequestError);
    expect((error as Error).cause).toBe(requestError);
    expect(String(error)).toContain("status 428");
    expect(String(error)).not.toContain("5511999999999");
    expect(String(error)).not.toContain("1234-5678");
    expect(reservation.commit).not.toHaveBeenCalled();
    expect(reservation.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a redacted code-mode disconnect status without committing auth", async () => {
    const socket = new FakePairingSocket();
    const requestPairingCode = vi.spyOn(socket, "requestPairingCode");
    const reservation = fakeReservation();
    const pairing = runWhatsAppPairingBootstrap({
      config: { ...coreConfig(), pairingMode: "code", pairingPhoneE164: "5511999999999" },
      providerIdentity: PATCHED_RC14,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory: () => socket,
      qrSink: { render: vi.fn(async () => {}) },
      codeSink: { render: vi.fn(async () => {}) },
    });
    await vi.waitFor(() => expect(requestPairingCode).toHaveBeenCalledTimes(1));
    const disconnect = Object.assign(new Error("closed 5511999999999 1234-5678"), {
      output: { statusCode: 401 },
    });
    socket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: disconnect },
    });
    const error = await pairing.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WhatsAppPairingCodeConnectionError);
    expect((error as Error).cause).toBe(disconnect);
    expect(String(error)).toContain("status 401");
    expect(String(error)).not.toContain("5511999999999");
    expect(String(error)).not.toContain("1234-5678");
    expect(reservation.commit).not.toHaveBeenCalled();
  });

  it("restarts once after code pairing has produced a valid auth snapshot, without another code", async () => {
    const first = new FakePairingSocket();
    const second = new FakePairingSocket();
    const requestPairingCode = vi.spyOn(first, "requestPairingCode");
    const reservation = fakeReservation();
    let socketCalls = 0;
    const socketFactory = vi.fn(() => {
      socketCalls += 1;
      return socketCalls === 1 ? first : second;
    });
    const pairing = runWhatsAppPairingBootstrap({
      config: { ...coreConfig(), pairingMode: "code", pairingPhoneE164: "5511999999999" },
      providerIdentity: PATCHED_RC14,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory,
      qrSink: { render: vi.fn(async () => {}) },
      codeSink: { render: vi.fn(async () => {}) },
    });

    await vi.waitFor(() => expect(requestPairingCode).toHaveBeenCalledTimes(1));
    first.emit("creds.update", {
      me: { id: "paired-user" },
      account: { keyIndex: 1 },
      signalIdentities: [{ identifier: { name: "paired-user", deviceId: 0 } }],
    });
    first.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    expect(requestPairingCode).toHaveBeenCalledTimes(1);
    second.emit("connection.update", { connection: "open" });
    await pairing;
    expect(reservation.commit).toHaveBeenCalledTimes(1);
  });

  it("fails closed on provider close without persisting auth or leaking QR", async () => {
    const socket = new FakePairingSocket();
    const reservation = fakeReservation();
    const socketFactory = vi.fn(() => socket);
    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerIdentity: PATCHED_RC14,
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
      providerIdentity: PATCHED_RC14,
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
        providerIdentity: PATCHED_RC14,
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
