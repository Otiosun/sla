import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadConfig } from "../platform/config/env.js";
import {
  assertWhatsAppPairingProviderVersionSupported,
  type SensitivePairingQrSink,
} from "./whatsapp-pairing-bootstrap.js";
import {
  loadWhatsAppPairingBootstrapConfig,
  type WhatsAppPairingBootstrapConfig,
} from "./whatsapp-pairing-bootstrap-config.js";

const require = createRequire(import.meta.url);

export type TerminalQrRenderer = (payload: string, callback: (rendered: string) => void) => void;

export type PairingCliExecutor = (
  config: WhatsAppPairingBootstrapConfig,
  providerVersion: string,
  qrSink: SensitivePairingQrSink,
) => Promise<void>;

export interface WhatsAppPairingBootstrapCliOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly isCI: boolean;
  readonly resolveProviderVersion: () => Promise<string>;
  readonly executePairing: PairingCliExecutor;
  readonly renderQr: TerminalQrRenderer;
  readonly writeStdout: (chunk: string) => void;
}

export class WhatsAppPairingInteractiveTerminalRequiredError extends Error {
  override readonly name = "WhatsAppPairingInteractiveTerminalRequiredError";
}

export class WhatsAppPairingPackageVersionResolutionError extends Error {
  override readonly name = "WhatsAppPairingPackageVersionResolutionError";
}

export class WhatsAppPairingQrOutputRejectedError extends Error {
  override readonly name = "WhatsAppPairingQrOutputRejectedError";
}

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function readJson(filePath: string): Promise<PackageMetadata | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as PackageMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveInstalledBaileysVersion(): Promise<string> {
  const entryPath = require.resolve("@whiskeysockets/baileys");
  let directory = path.dirname(entryPath);

  while (true) {
    const metadata = await readJson(path.join(directory, "package.json"));
    if (metadata?.name === "@whiskeysockets/baileys") {
      if (typeof metadata.version !== "string" || metadata.version.length === 0) {
        throw new WhatsAppPairingPackageVersionResolutionError(
          "Installed Baileys package metadata has no valid version",
        );
      }
      return metadata.version;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new WhatsAppPairingPackageVersionResolutionError(
    "Unable to resolve the installed Baileys package version",
  );
}

export function createTerminalPairingQrSink(
  renderQr: TerminalQrRenderer,
  writeStdout: (chunk: string) => void,
): SensitivePairingQrSink {
  return {
    async render(qr: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        try {
          renderQr(qr, (rendered) => {
            if (rendered.includes(qr)) {
              reject(
                new WhatsAppPairingQrOutputRejectedError(
                  "Terminal QR renderer returned raw pairing material",
                ),
              );
              return;
            }
            writeStdout(`${rendered}\n`);
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
  };
}

function assertInteractiveTerminal(options: WhatsAppPairingBootstrapCliOptions): void {
  if (!options.stdinIsTTY || !options.stdoutIsTTY || options.isCI) {
    throw new WhatsAppPairingInteractiveTerminalRequiredError(
      "WhatsApp first pairing requires a local interactive terminal and is blocked in CI",
    );
  }
}

export async function runWhatsAppPairingBootstrapCli(
  options: WhatsAppPairingBootstrapCliOptions,
): Promise<void> {
  const appConfig = loadConfig(options.env);
  const config = loadWhatsAppPairingBootstrapConfig(appConfig, options.env);
  const providerVersion = await options.resolveProviderVersion();

  assertWhatsAppPairingProviderVersionSupported(providerVersion);
  assertInteractiveTerminal(options);

  await options.executePairing(
    config,
    providerVersion,
    createTerminalPairingQrSink(options.renderQr, options.writeStdout),
  );
}
