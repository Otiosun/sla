import { z } from "zod";
import type { AppConfig } from "../platform/config/env.js";

const sessionKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const whatsappRuntimeSchema = z.object({
  WHATSAPP_SESSION_KEY: sessionKeySchema,
  WHATSAPP_AUTH_KEY_BASE64: z.string().min(1),
  WHATSAPP_AUTH_KEY_VERSION: positiveInteger(1),
  WHATSAPP_OUTBOX_POLL_MS: positiveInteger(500),
});

export interface WhatsAppRuntimeConfig {
  readonly sessionKey: string;
  readonly authEncryptionKey: Buffer;
  readonly authEncryptionKeyVersion: number;
  readonly outboxPollMs: number;
}

export class WhatsAppRuntimeConfigError extends Error {
  override readonly name = "WhatsAppRuntimeConfigError";
}

function decodeKey(value: string): Buffer {
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) {
    throw new WhatsAppRuntimeConfigError(
      "WHATSAPP_AUTH_KEY_BASE64 must be canonical base64 for exactly 32 bytes",
    );
  }
  return decoded;
}

export function loadWhatsAppRuntimeConfig(
  appConfig: Pick<AppConfig, "appEnv">,
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppRuntimeConfig | null {
  const runtimeKeys = [
    "WHATSAPP_SESSION_KEY",
    "WHATSAPP_AUTH_KEY_BASE64",
    "WHATSAPP_AUTH_KEY_VERSION",
    "WHATSAPP_OUTBOX_POLL_MS",
  ] as const;
  const anyRuntimeValue = runtimeKeys.some((key) => env[key] !== undefined);
  const required = appConfig.appEnv === "staging" || appConfig.appEnv === "production";
  if (!required && !anyRuntimeValue) return null;

  const parsed = whatsappRuntimeSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new WhatsAppRuntimeConfigError(`Invalid WhatsApp runtime configuration: ${issues}`);
  }

  return {
    sessionKey: parsed.data.WHATSAPP_SESSION_KEY,
    authEncryptionKey: decodeKey(parsed.data.WHATSAPP_AUTH_KEY_BASE64),
    authEncryptionKeyVersion: parsed.data.WHATSAPP_AUTH_KEY_VERSION,
    outboxPollMs: parsed.data.WHATSAPP_OUTBOX_POLL_MS,
  };
}
