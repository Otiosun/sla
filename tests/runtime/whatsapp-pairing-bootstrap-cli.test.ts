import { describe, expect, it, vi } from "vitest";
import {
  createTerminalPairingQrSink,
  resolveInstalledBaileysVersion,
  runWhatsAppPairingBootstrapCli,
  WhatsAppPairingInteractiveTerminalRequiredError,
} from "../../src/operations/whatsapp-pairing-bootstrap-cli.js";
import { WhatsAppPairingProviderVersionBlockedError } from "../../src/operations/whatsapp-pairing-bootstrap.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);

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
  it("reads the actual installed Baileys package version", async () => {
    await expect(resolveInstalledBaileysVersion()).resolves.toBe("7.0.0-rc14");
  });

  it("blocks the known-broken provider before executing any DB/provider work", async () => {
    const executePairing = vi.fn(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderVersion: vi.fn(async () => "7.0.0-rc14"),
        executePairing,
        renderQr: vi.fn(),
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(executePairing).not.toHaveBeenCalled();
  });

  it("requires a local interactive terminal before executing pairing", async () => {
    const executePairing = vi.fn(async () => {});

    await expect(
      runWhatsAppPairingBootstrapCli({
        env: validEnv(),
        stdinIsTTY: false,
        stdoutIsTTY: true,
        isCI: false,
        resolveProviderVersion: vi.fn(async () => "7.0.0-rc15"),
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
        resolveProviderVersion: vi.fn(async () => "7.0.0-rc15"),
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

  it("passes only the validated release config and sensitive sink to execution", async () => {
    const executePairing = vi.fn(async () => {});
    const renderQr = vi.fn((_payload: string, callback: (rendered: string) => void) => {
      callback("QR-MATRIX");
    });
    const writeStdout = vi.fn();

    await runWhatsAppPairingBootstrapCli({
      env: validEnv(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      resolveProviderVersion: vi.fn(async () => "7.0.0-rc15"),
      executePairing,
      renderQr,
      writeStdout,
    });

    expect(executePairing).toHaveBeenCalledTimes(1);
    const [config, providerVersion, qrSink] = executePairing.mock.calls[0] ?? [];
    expect(config?.appEnv).toBe("staging");
    expect(config?.deploymentRevision).toBe(REVISION);
    expect(providerVersion).toBe("7.0.0-rc15");
    await qrSink?.render("payload-never-written-raw");
    expect(writeStdout.mock.calls.flat().join("")).not.toContain("payload-never-written-raw");
  });
});
