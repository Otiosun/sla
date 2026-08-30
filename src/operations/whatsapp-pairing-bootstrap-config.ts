import { z } from "zod";
import type { AppConfig } from "../platform/config/env.js";
import {
  loadWhatsAppRuntimeConfig,
  type WhatsAppRuntimeConfig,
} from "../runtime/whatsapp-runtime-config.js";

const pairingEnvSchema = z.object({
  WHATSAPP_PAIRING_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(120_000),
});

export interface WhatsAppPairingBootstrapConfig {
  readonly appEnv: "staging" | "production";
  readonly sessionKey: string;
  readonly authEncryptionKey: Buffer;
  readonly authEncryptionKeyVersion: number;
  readonly deploymentRevision: string;
  readonly timeoutMs: number;
}

export class WhatsAppPairingBootstrapConfigError extends Error {
  override readonly name = "WhatsAppPairingBootstrapConfigError";
}

function releaseRuntimeConfig(
  appConfig: Pick<AppConfig, "appEnv">,
  env: NodeJS.ProcessEnv,
): WhatsAppRuntimeConfig & { readonly deploymentRevision: string } {
  if (appConfig.appEnv !== "staging" && appConfig.appEnv !== "production") {
    throw new WhatsAppPairingBootstrapConfigError(
      "WhatsApp first pairing is restricted to staging or production",
    );
  }

  let runtimeConfig: WhatsAppRuntimeConfig | null;
  try {
    runtimeConfig = loadWhatsAppRuntimeConfig(appConfig, env);
  } catch {
    throw new WhatsAppPairingBootstrapConfigError("WhatsApp pairing runtime configuration is invalid");
  }
  if (runtimeConfig === null || runtimeConfig.deploymentRevision === null) {
    throw new WhatsAppPairingBootstrapConfigError(
      "WhatsApp pairing requires a release-bound runtime configuration",
    );
  }
  return runtimeConfig as WhatsAppRuntimeConfig & { readonly deploymentRevision: string };
}

export function loadWhatsAppPairingBootstrapConfig(
  appConfig: Pick<AppConfig, "appEnv">,
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppPairingBootstrapConfig {
  const runtimeConfig = releaseRuntimeConfig(appConfig, env);
  const parsed = pairingEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new WhatsAppPairingBootstrapConfigError("WHATSAPP_PAIRING_TIMEOUT_MS is invalid");
  }

  return {
    appEnv: appConfig.appEnv,
    sessionKey: runtimeConfig.sessionKey,
    authEncryptionKey: Buffer.from(runtimeConfig.authEncryptionKey),
    authEncryptionKeyVersion: runtimeConfig.authEncryptionKeyVersion,
    deploymentRevision: runtimeConfig.deploymentRevision,
    timeoutMs: parsed.data.WHATSAPP_PAIRING_TIMEOUT_MS,
  };
}
