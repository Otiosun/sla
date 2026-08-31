import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadOrCreateStagingWhatsAppLocalSecrets } from "../../src/operations/staging-whatsapp-pairing-helper.js";
import {
  readHiddenTerminalInput,
  resolveDefaultStagingWhatsAppSecretFilePath,
  runStagingWhatsAppPairingHelperCli,
  StagingWhatsAppPairingHelperInteractiveTerminalRequiredError,
  type StagingPairingExecutor,
  type StagingPairingSecretInput,
} from "../../src/operations/staging-whatsapp-pairing-helper-cli.js";

const REVISION = "b".repeat(40);
const PROJECT_REF = "abcdefghijklmnopqrst";
const POOLER_HOST = "aws-0-sa-east-1.pooler.supabase.com";
const JIT_TOKEN = "temporary-secret-token";

class FakeSecretInput extends EventEmitter implements StagingPairingSecretInput {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }
}

describe("staging WhatsApp pairing helper CLI", () => {
  it("reads the JIT token without echoing the typed secret", async () => {
    const input = new FakeSecretInput();
    const writes: string[] = [];

    const pending = readHiddenTerminalInput({
      prompt: "Supabase Temporary Access token: ",
      input,
      write: (chunk) => writes.push(chunk),
    });
    input.emit("data", JIT_TOKEN);
    input.emit("data", "\r");

    await expect(pending).resolves.toBe(JIT_TOKEN);
    expect(writes.join("")).toContain("Supabase Temporary Access token:");
    expect(writes.join("")).not.toContain(JIT_TOKEN);
    expect(input.isRaw).toBe(false);
  });

  it("blocks CI or a non-interactive terminal before reading checkout or secrets", async () => {
    const getCheckoutInfo = vi.fn(async () => ({
      branch: "main",
      revision: REVISION,
      originMainRevision: REVISION,
      isClean: true,
    }));
    const promptVisible = vi.fn(async () => PROJECT_REF);
    const promptSecret = vi.fn(async () => JIT_TOKEN);
    const executePairing = vi.fn<StagingPairingExecutor>(async () => {});

    await expect(
      runStagingWhatsAppPairingHelperCli({
        stdinIsTTY: false,
        stdoutIsTTY: true,
        isCI: false,
        secretFilePath: "/unused/staging-whatsapp.json",
        caPath: "/unused/ca.crt",
        getCheckoutInfo,
        promptVisible,
        promptSecret,
        executePairing,
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(StagingWhatsAppPairingHelperInteractiveTerminalRequiredError);

    await expect(
      runStagingWhatsAppPairingHelperCli({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        isCI: true,
        secretFilePath: "/unused/staging-whatsapp.json",
        caPath: "/unused/ca.crt",
        getCheckoutInfo,
        promptVisible,
        promptSecret,
        executePairing,
        writeStdout: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(StagingWhatsAppPairingHelperInteractiveTerminalRequiredError);

    expect(getCheckoutInfo).not.toHaveBeenCalled();
    expect(promptVisible).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
    expect(executePairing).not.toHaveBeenCalled();
  });

  it("creates local pairing secrets on first run and executes only the staging runtime plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pokemon-pairing-cli-first-"));
    const secretFilePath = join(directory, "staging-whatsapp.json");
    const promptVisible = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce(PROJECT_REF)
      .mockResolvedValueOnce(POOLER_HOST);
    const promptSecret = vi.fn(async () => JIT_TOKEN);
    const executePairing = vi.fn<StagingPairingExecutor>(async () => {});
    const writes: string[] = [];

    await runStagingWhatsAppPairingHelperCli({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      secretFilePath,
      caPath: "/trusted/repo/certs/supabase/prod-ca-2021.crt",
      getCheckoutInfo: vi.fn(async () => ({
        branch: "main",
        revision: REVISION,
        originMainRevision: REVISION,
        isClean: true,
      })),
      promptVisible,
      promptSecret,
      executePairing,
      writeStdout: (chunk) => writes.push(chunk),
    });

    expect(promptVisible).toHaveBeenCalledTimes(2);
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(executePairing).toHaveBeenCalledTimes(1);
    const [plan] = executePairing.mock.calls[0] ?? [];
    expect(plan?.env.APP_ENV).toBe("staging");
    expect(plan?.env.DATABASE_URL).toContain(`pokemon_runtime.${PROJECT_REF}`);
    expect(plan?.env).not.toHaveProperty("MIGRATOR_DATABASE_URL");
    expect(writes.join("")).not.toContain(JIT_TOKEN);
    expect(writes.join("")).not.toContain(plan?.env.WHATSAPP_AUTH_KEY_BASE64 ?? "secret-missing");
    expect(writes.join("")).not.toContain(plan?.env.DATABASE_URL ?? "url-missing");
  });

  it("reuses stored project metadata and auth key without asking visible setup questions again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pokemon-pairing-cli-replay-"));
    const secretFilePath = join(directory, "staging-whatsapp.json");
    await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath: secretFilePath,
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
    });
    const promptVisible = vi.fn(async () => "should-not-be-read");
    const executePairing = vi.fn<StagingPairingExecutor>(async () => {});

    await runStagingWhatsAppPairingHelperCli({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      secretFilePath,
      caPath: "/trusted/repo/certs/supabase/prod-ca-2021.crt",
      getCheckoutInfo: vi.fn(async () => ({
        branch: "main",
        revision: REVISION,
        originMainRevision: REVISION,
        isClean: true,
      })),
      promptVisible,
      promptSecret: vi.fn(async () => JIT_TOKEN),
      executePairing,
      writeStdout: vi.fn(),
    });

    expect(promptVisible).not.toHaveBeenCalled();
    expect(executePairing).toHaveBeenCalledTimes(1);
  });

  it("keeps the default secret file outside the repository on Windows and POSIX", () => {
    expect(
      resolveDefaultStagingWhatsAppSecretFilePath({
        platform: "win32",
        env: {
          LOCALAPPDATA: "C:\\Users\\Trainer\\AppData\\Local",
        },
        homeDirectory: "C:\\Users\\Trainer",
      }),
    ).toBe("C:\\Users\\Trainer\\AppData\\Local\\pokemon-rpg\\staging-whatsapp.json");

    expect(
      resolveDefaultStagingWhatsAppSecretFilePath({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/home/trainer/.config-custom",
        },
        homeDirectory: "/home/trainer",
      }),
    ).toBe("/home/trainer/.config-custom/pokemon-rpg/staging-whatsapp.json");
  });
});
