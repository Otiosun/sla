import type { InstalledBaileysIdentity } from "../adapters/whatsapp/baileys-package-version.js";
import type { BaileysWaWebVersion } from "../adapters/whatsapp/baileys-provider-contracts.js";
import { loadConfig } from "../platform/config/env.js";
import {
  assertWhatsAppPairingProviderIdentitySupported,
  type SensitivePairingQrSink,
} from "./whatsapp-pairing-bootstrap.js";
import {
  loadWhatsAppPairingBootstrapConfig,
  type WhatsAppPairingBootstrapConfig,
} from "./whatsapp-pairing-bootstrap-config.js";

export {
  resolveInstalledBaileysIdentity,
  resolveInstalledBaileysVersion,
  WhatsAppPairingPackageVersionResolutionError,
} from "../adapters/whatsapp/baileys-package-version.js";

export type TerminalQrRenderer = (payload: string, callback: (rendered: string) => void) => void;

export type PairingCliExecutor = (
  config: WhatsAppPairingBootstrapConfig,
  providerIdentity: InstalledBaileysIdentity,
  waWebVersion: BaileysWaWebVersion,
  qrSink: SensitivePairingQrSink,
) => Promise<void>;

export interface WhatsAppPairingBootstrapCliOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly isCI: boolean;
  readonly resolveProviderIdentity: () => Promise<InstalledBaileysIdentity>;
  readonly resolveWaWebVersion: () => Promise<BaileysWaWebVersion>;
  readonly executePairing: PairingCliExecutor;
  readonly renderQr: TerminalQrRenderer;
  readonly writeStdout: (chunk: string) => void;
}

export class WhatsAppPairingInteractiveTerminalRequiredError extends Error {
  override readonly name = "WhatsAppPairingInteractiveTerminalRequiredError";
}

export class WhatsAppPairingQrOutputRejectedError extends Error {
  override readonly name = "WhatsAppPairingQrOutputRejectedError";
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
  const providerIdentity = await options.resolveProviderIdentity();

  assertWhatsAppPairingProviderIdentitySupported(providerIdentity, config.appEnv);
  assertInteractiveTerminal(options);

  const waWebVersion = await options.resolveWaWebVersion();

  await options.executePairing(
    config,
    providerIdentity,
    waWebVersion,
    createTerminalPairingQrSink(options.renderQr, options.writeStdout),
  );
}
