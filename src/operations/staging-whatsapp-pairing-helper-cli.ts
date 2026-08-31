import { execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertStagingWhatsAppPairingCheckout,
  buildStagingWhatsAppPairingPlan,
  loadOrCreateStagingWhatsAppLocalSecrets,
  readStagingWhatsAppLocalSecrets,
} from "./staging-whatsapp-pairing-helper.js";

export interface StagingPairingSecretInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): this;
  resume(): this;
  pause(): this;
  setEncoding(encoding: BufferEncoding): this;
  on(event: "data", listener: (chunk: string) => void): this;
  off(event: "data", listener: (chunk: string) => void): this;
}

type StagingPairingPlan = ReturnType<typeof buildStagingWhatsAppPairingPlan>;

export type StagingPairingExecutor = (plan: StagingPairingPlan) => Promise<void>;

export class StagingWhatsAppPairingHelperInteractiveTerminalRequiredError extends Error {
  constructor() {
    super("Staging WhatsApp pairing helper requires a trusted local interactive terminal");
    this.name = "StagingWhatsAppPairingHelperInteractiveTerminalRequiredError";
  }
}

export class StagingWhatsAppPairingHelperInterruptedError extends Error {
  constructor() {
    super("Staging WhatsApp pairing helper was interrupted");
    this.name = "StagingWhatsAppPairingHelperInterruptedError";
  }
}

export function readHiddenTerminalInput(input: {
  prompt: string;
  input: StagingPairingSecretInput;
  write: (chunk: string) => void;
}): Promise<string> {
  input.write(input.prompt);

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    let settled = false;
    const previousRawMode = input.input.isRaw ?? false;

    const cleanup = (): void => {
      input.input.off("data", onData);
      input.input.setRawMode(previousRawMode);
      input.input.pause();
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      input.write("\n");
      resolvePromise(value.trim());
    };

    const interrupt = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      input.write("\n");
      rejectPromise(new StagingWhatsAppPairingHelperInterruptedError());
    };

    function onData(chunk: string): void {
      for (const character of chunk) {
        if (settled) {
          return;
        }
        if (character === "\u0003") {
          interrupt();
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    }

    input.input.setEncoding("utf8");
    input.input.setRawMode(true);
    input.input.resume();
    input.input.on("data", onData);
  });
}

export function resolveDefaultStagingWhatsAppSecretFilePath(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
}): string {
  if (input.platform === "win32") {
    const baseDirectory = input.env.LOCALAPPDATA ?? input.env.APPDATA ?? input.homeDirectory;
    return win32.join(baseDirectory, "pokemon-rpg", "staging-whatsapp.json");
  }

  const baseDirectory = input.env.XDG_CONFIG_HOME ?? posix.join(input.homeDirectory, ".config");
  return posix.join(baseDirectory, "pokemon-rpg", "staging-whatsapp.json");
}

function defaultSecretFilePath(): string {
  return resolveDefaultStagingWhatsAppSecretFilePath({
    platform: platform(),
    env: process.env,
    homeDirectory: homedir(),
  });
}

async function defaultCheckoutInfo(): Promise<{
  branch: string;
  revision: string;
  isClean: boolean;
}> {
  const runGit = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
  return {
    branch: runGit(["branch", "--show-current"]),
    revision: runGit(["rev-parse", "HEAD"]),
    isClean: runGit(["status", "--porcelain"]).length === 0,
  };
}

async function defaultVisiblePrompt(prompt: string): Promise<string> {
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await interfaceHandle.question(prompt)).trim();
  } finally {
    interfaceHandle.close();
  }
}

async function defaultPairingExecutor(plan: StagingPairingPlan): Promise<void> {
  const caPath = plan.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) {
    throw new Error("Staging pairing plan did not provide NODE_EXTRA_CA_CERTS");
  }
  await access(caPath);

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, ["ops:bootstrap:whatsapp"], {
      env: { ...process.env, ...plan.env },
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `Canonical WhatsApp pairing bootstrap exited unsuccessfully (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  });
}

export async function runStagingWhatsAppPairingHelperCli(options: {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  isCI?: boolean;
  secretFilePath?: string;
  caPath?: string;
  getCheckoutInfo?: () => Promise<{ branch: string; revision: string; isClean: boolean }>;
  promptVisible?: (prompt: string) => Promise<string>;
  promptSecret: (prompt: string) => Promise<string>;
  executePairing?: StagingPairingExecutor;
  writeStdout: (chunk: string) => void;
}): Promise<void> {
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const isCI = options.isCI ?? Boolean(process.env.CI);
  if (!stdinIsTTY || !stdoutIsTTY || isCI) {
    throw new StagingWhatsAppPairingHelperInteractiveTerminalRequiredError();
  }

  const getCheckoutInfo = options.getCheckoutInfo ?? defaultCheckoutInfo;
  const promptVisible = options.promptVisible ?? defaultVisiblePrompt;
  const executePairing = options.executePairing ?? defaultPairingExecutor;
  const secretFilePath = options.secretFilePath ?? defaultSecretFilePath();
  const caPath = options.caPath ?? resolve(process.cwd(), "certs/supabase/prod-ca-2021.crt");

  const checkout = await getCheckoutInfo();
  assertStagingWhatsAppPairingCheckout(checkout);

  let secrets = await readStagingWhatsAppLocalSecrets({ filePath: secretFilePath });
  let created = false;
  if (!secrets) {
    const projectRef = await promptVisible("Supabase staging project ref: ");
    const poolerHost = await promptVisible("Supabase staging pooler host: ");
    const loaded = await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath: secretFilePath,
      projectRef: projectRef.trim(),
      poolerHost: poolerHost.trim(),
    });
    secrets = loaded.secrets;
    created = loaded.created;
  }

  const jitToken = await options.promptSecret("Supabase Temporary Access token: ");
  const plan = buildStagingWhatsAppPairingPlan({
    revision: checkout.revision,
    jitToken,
    caPath,
    secrets,
  });

  options.writeStdout(
    [
      "\nStaging WhatsApp pairing helper ready.",
      `Environment: ${plan.publicSummary.environment}`,
      `Database role: ${plan.publicSummary.databaseRole}`,
      `TLS: ${plan.publicSummary.tls}`,
      `Session: ${plan.publicSummary.sessionKey}`,
      `Revision: ${plan.publicSummary.revision}`,
      `Local encryption key: ${created ? "created" : "reused"}`,
      `Local secret file: ${secretFilePath}`,
      "Starting canonical interactive pairing...",
      "",
    ].join("\n"),
  );

  await executePairing(plan);
  options.writeStdout("\nStaging WhatsApp pairing bootstrap completed.\n");
}
