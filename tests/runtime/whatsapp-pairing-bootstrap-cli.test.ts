import { describe, expect, it, vi } from "vitest";
import {
  createTerminalPairingQrSink,
  type PairingCliExecutor,
  resolveInstalledBaileysIdentity,
  runWhatsAppPairingBootstrapCli,
  WhatsAppPairingInteractiveTerminalRequiredError,
} from "../../src/operations/whatsapp-pairing-bootstrap-cli.js";
import { WhatsAppPairingProviderVersionBlockedError } from "../../src/operations/whatsapp-pairing-bootstrap.js";

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

describe("WhatsApp pairing CLI boundary", () => {
  it("reads the actual installed Baileys package identity without inventing compatibility", async () => {
    await expect(resolveInstalledBaileysIdentity()).resolves.toEqual(BARE_RC14);
  });

  it("blocks bare rc14 before executing any DB/provider work", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderIdentity: vi.fn(async () => BARE_RC14),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("blocks a forged or unknown compatibility identity before execution", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderIdentity: vi.fn(async () => ({
          version: "7.0.0-rc15",
          pairingCompatibility: "rc14-companion-reg-refresh-v1",
        })),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("requires a local interactive terminal before executing pairing", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: false,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderIdentity: vi.fn(async () => PATCHED_RC14),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingInteractiveTerminalRequiredError);

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: true,
        resolveProviderIdentity: vi.fn(async () => PATCHED_RC14),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingInteractiveTerminalRequiredError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("renders QR only through the terminal renderer and never writes the raw payload", async () => {
    const writes: string[] = [];
    const renderQr = vi.fn((payload: string, callback: (rendered: string) => void) => {
      expect(payload).toBe("super-sensitive-qr-payload");
      callback("██  ██\n  ██  ");
    });
    const sink = createTerminalPairingQrSink(renderQr, (chunk) => {
      writes.push(chunk);
    });

    await sink.render("super-sensitive-qr-payload");

    expect(renderQr).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("██");
    expect(writes.join("")).not.toContain("super-sensitive-qr-payload");
  });

  it("passes only the validated release config, audited provider identity and sensitive sink", async () => {
    const executePairing = vi.fn<PairingCliExecutor>(async () => {});
    const renderQr = vi.fn((_payload: string, callback: (rendered: string) => void) => {
      callback("QR-MATRIX");
    });
    const writeStdout = vi.fn();

    await runWhatsAppPairingBootstrapCli({
      env: validEnv(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      resolveProviderIdentity: vi.fn(async () => PATCHED_RC14),
      executePairing,
      renderQr,
      writeStdout,
    });

    expect(executePairing).toHaveBeenCalledTimes(1);
    const [config, providerIdentity, qrSink] = executePairing.mock.calls[0] ?? [];
    expect(config?.appEnv).toBe("staging");
    expect(config?.deploymentRevision).toBe(REVISION);
    expect(providerIdentity).toEqual(PATCHED_RC14);
    await qrSink?.render("payload-never-written-raw");
    expect(writeStdout.mock.calls.flat().join("")).not.toContain("payload-never-written-raw");
  });
});
