import { z } from "zod";
import type { AppConfig } from "../platform/config/env.js";
import {
  loadWhatsAppRuntimeConfig,
  type WhatsAppRuntimeConfig,
} from "../runtime/whatsapp-runtime-config.js";

const pairingEnvSchema = z.object({
  WHATSAPP_PAIRING_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(120_000),
  WHATSAPP_PAIRING_MODE: z.enum(["qr", "code"]).default("qr"),
  WHATSAPP_PAIRING_PHONE_E164: z.string().optional(),
});

export interface WhatsAppPairingBootstrapConfig {
  readonly appEnv: "staging" | "production";
  readonly sessionKey: string;
  readonly authEncryptionKey: Buffer;
  readonly authEncryptionKeyVersion: number;
  readonly deploymentRevision: string;
  readonly timeoutMs: number;
  readonly pairingMode?: "qr" | "code";
  readonly pairingPhoneE164?: string | null;
}

export class WhatsAppPairingBootstrapConfigError extends Error {
  override readonly name = "WhatsAppPairingBootstrapConfigError";
}

function normalizePairingPhone(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+?[1-9]\d{5,14}$/.test(compact)) {
    throw new WhatsAppPairingBootstrapConfigError(
      "WHATSAPP_PAIRING_PHONE_E164 must be a valid E.164 phone number",
    );
  }
  return compact.replace(/^\+/, "");
}

function assertReleaseEnvironment(
  appEnv: AppConfig["appEnv"],
): asserts appEnv is "staging" | "production" {
  if (appEnv !== "staging" && appEnv !== "production") {
    throw new WhatsAppPairingBootstrapConfigError(
      "WhatsApp first pairing is restricted to staging or production",
    );
  }
}

function releaseRuntimeConfig(
  appConfig: Pick<AppConfig, "appEnv">,
  env: NodeJS.ProcessEnv,
): WhatsAppRuntimeConfig & { readonly deploymentRevision: string } {
  let runtimeConfig: WhatsAppRuntimeConfig | null;
  try {
    runtimeConfig = loadWhatsAppRuntimeConfig(appConfig, env);
  } catch {
    throw new WhatsAppPairingBootstrapConfigError(
      "WhatsApp pairing runtime configuration is invalid",
    );
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
  const appEnv = appConfig.appEnv;
  assertReleaseEnvironment(appEnv);
  const runtimeConfig = releaseRuntimeConfig(appConfig, env);
  const parsed = pairingEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new WhatsAppPairingBootstrapConfigError("WHATSAPP_PAIRING_TIMEOUT_MS is invalid");
  }
  const pairingPhoneE164 = normalizePairingPhone(parsed.data.WHATSAPP_PAIRING_PHONE_E164);
  if (parsed.data.WHATSAPP_PAIRING_MODE === "code" && pairingPhoneE164 === null) {
    throw new WhatsAppPairingBootstrapConfigError(
      "WHATSAPP_PAIRING_PHONE_E164 is required when WHATSAPP_PAIRING_MODE=code",
    );
  }

  return {
    appEnv,
    sessionKey: runtimeConfig.sessionKey,
    authEncryptionKey: Buffer.from(runtimeConfig.authEncryptionKey),
    authEncryptionKeyVersion: runtimeConfig.authEncryptionKeyVersion,
    deploymentRevision: runtimeConfig.deploymentRevision,
    timeoutMs: parsed.data.WHATSAPP_PAIRING_TIMEOUT_MS,
    pairingMode: parsed.data.WHATSAPP_PAIRING_MODE,
    pairingPhoneE164,
  };
}
