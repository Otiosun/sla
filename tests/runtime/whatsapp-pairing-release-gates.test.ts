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
import {
  assertWhatsAppPairingProviderIdentitySupported,
  runWhatsAppPairingBootstrap,
  WhatsAppPairingProviderVersionBlockedError,
} from "../../src/operations/whatsapp-pairing-bootstrap.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);
const PATCHED_RC14 = {
  version: "7.0.0-rc14",
  pairingCompatibility: "rc14-companion-reg-refresh-v1",
} as const;
const WA_WEB_VERSION: BaileysWaWebVersion = [2, 3000, 1042626022];

class FakePairingSocket implements BaileysSocketLike {
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

  end(): void {}

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function stagingEnv(): NodeJS.ProcessEnv {
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

function coreConfig(appEnv: "staging" | "production" = "staging") {
  return {
    appEnv,
    sessionKey: `pokemon-${appEnv}`,
    authEncryptionKey: AUTH_KEY,
    authEncryptionKeyVersion: 1,
    deploymentRevision: REVISION,
    timeoutMs: 1_000,
  };
}

describe("WhatsApp first-pairing release gates", () => {
  it("allows the audited rc14 identity only in staging until production is explicitly promoted", () => {
    expect(() => assertWhatsAppPairingProviderIdentitySupported(PATCHED_RC14, "staging")).not.toThrow();
    expect(() => assertWhatsAppPairingProviderIdentitySupported(PATCHED_RC14, "production")).toThrow(
      WhatsAppPairingProviderVersionBlockedError,
    );
  });

  it("accepts only a freshly resolved WhatsApp Web protocol tuple", async () => {
    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({ version: WA_WEB_VERSION, isLatest: true })),
    ).resolves.toEqual(WA_WEB_VERSION);

    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({ version: WA_WEB_VERSION, isLatest: false })),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);

    await expect(
      resolveLatestWhatsAppWebVersion(async () => ({ version: [2, 3000], isLatest: true })),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);
  });

  it("resolves the protocol after identity and TTY gates but before pairing execution", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});
    const resolveWaWebVersion = vi.fn(async () => WA_WEB_VERSION);

    await runWhatsAppPairingBootstrapCli({
      env: { ...stagingEnv(), WHATSAPP_WEB_VERSION: "9.9.9" },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      resolveProviderIdentity: vi.fn(async () => PATCHED_RC14),
      resolveWaWebVersion,
      executePairing,
      renderQr: vi.fn(),
      writeStdout: vi.fn(),
    });

    expect(resolveWaWebVersion).toHaveBeenCalledTimes(1);
    const [config, providerIdentity, waWebVersion] = executePairing.mock.calls[0] ?? [];
    expect(config?.appEnv).toBe("staging");
    expect(providerIdentity).toEqual(PATCHED_RC14);
    expect(waWebVersion).toEqual(WA_WEB_VERSION);
  });

  it("fails before pairing execution when the current WhatsApp Web version cannot be resolved", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: stagingEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderIdentity: vi.fn(async () => PATCHED_RC14),
        resolveWaWebVersion: vi.fn(async () => {
          throw new WhatsAppWebVersionResolutionError("WhatsApp Web version unavailable");
        }),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppWebVersionResolutionError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("passes the resolved protocol tuple explicitly to the pairing socket", async () => {
    const socket = new FakePairingSocket();
    const socketConfigs: BaileysSocketConfigLike[] = [];
    const reservation = {
      commit: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const pairing = runWhatsAppPairingBootstrap({
      config: coreConfig("staging"),
      providerIdentity: PATCHED_RC14,
      waWebVersion: WA_WEB_VERSION,
      reserveBootstrap: vi.fn(async () => reservation),
      socketFactory: (config) => {
        socketConfigs.push(config);
        return socket;
      },
      qrSink: { render: vi.fn(async () => {}) },
    });

    await vi.waitFor(() => expect(socketConfigs).toHaveLength(1));
    expect(socketConfigs[0]?.version).toEqual(WA_WEB_VERSION);

    socket.emit("creds.update", { registered: true, me: { id: "paired-user" } });
    socket.emit("connection.update", { connection: "open" });
    await pairing;
  });

  it("blocks production before reserving auth or creating a socket", async () => {
    const reserveBootstrap = vi.fn(async () => ({
      commit: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const socketFactory = vi.fn(() => new FakePairingSocket());

    await expect(
      runWhatsAppPairingBootstrap({
        config: coreConfig("production"),
        providerIdentity: PATCHED_RC14,
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap,
        socketFactory,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(reserveBootstrap).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
