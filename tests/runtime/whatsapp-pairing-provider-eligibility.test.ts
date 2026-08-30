import { describe, expect, it, vi } from "vitest";
import type {
  BaileysEventSourceLike,
  BaileysSocketConfigLike,
  BaileysSocketLike,
  BaileysWaWebVersion,
} from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import {
  resolveLatestWhatsAppWebVersion,
  WhatsAppWebVersionResolutionError,
} from "../../src/adapters/whatsapp/baileys-wa-web-version.js";
import {
  type PairingCliExecutor,
  runWhatsAppPairingBootstrapCli,
} from "../../src/operations/whatsapp-pairing-bootstrap-cli.js";
import { runWhatsAppPairingBootstrap } from "../../src/operations/whatsapp-pairing-bootstrap.js";

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

describe("WhatsApp live protocol eligibility", () => {
  it("accepts only a freshly resolved WhatsApp Web protocol tuple", async () => {
    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({
        version: WA_WEB_VERSION,
        isLatest: true,
      })),
    ).resolves.toEqual(WA_WEB_VERSION);

    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({
        version: WA_WEB_VERSION,
        isLatest: false,
      })),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);

    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({
        version: [2, 3000],
        isLatest: true,
      })),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);
  });

  it("fails before pairing execution when the live protocol version cannot be resolved", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderVersion: vi.fn(async () => "7.0.0-rc14"),
        resolveWaWebVersion: vi.fn(async () => {
          throw new WhatsAppWebVersionResolutionError("WhatsApp Web version is unavailable");
        }),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("passes the resolved protocol tuple through the CLI without operator override", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await runWhatsAppPairingBootstrapCli({
      env: { ...validEnv(), WHATSAPP_WEB_VERSION: "9.9.9" },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      resolveProviderVersion: vi.fn(async () => "7.0.0-rc14"),
      resolveWaWebVersion: vi.fn(async () => WA_WEB_VERSION),
      executePairing,
      renderQr: vi.fn(),
      writeStdout: vi.fn(),
    });

    const [, providerVersion, waWebVersion] = executePairing.mock.calls[0] ?? [];
    expect(providerVersion).toBe("7.0.0-rc14");
    expect(waWebVersion).toEqual(WA_WEB_VERSION);
  });

  it("passes the resolved protocol tuple explicitly to the pairing socket", async () => {
    const socket = new FakePairingSocket();
    const socketConfigs: BaileysSocketConfigLike[] = [];
    const reservation = {
      commit: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const socketFactory = vi.fn((config: BaileysSocketConfigLike) => {
      socketConfigs.push(config);
      return socket;
    });

    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig(),
      providerVersion: "7.0.0-rc14",
      waWebVersion: WA_WEB_VERSION,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory,
      qrSink: { render: vi.fn(async () => {}) },
    });

    await vi.waitFor(() => expect(socketConfigs).toHaveLength(1));
    expect(socketConfigs[0]?.version).toEqual(WA_WEB_VERSION);

    socket.emit("creds.update", { registered: true, me: { id: "paired-user" } });
    socket.emit("connection.update", { connection: "open" });
    await pairing;
  });
});
