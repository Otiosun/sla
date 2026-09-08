import { createPublicKey } from "node:crypto";
import { z } from "zod";

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const runtimeSchema = z.object({
  PUBLIC_VERIFICATION_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  PUBLIC_VERIFICATION_PORT: z.coerce.number().int().min(1).max(65_535).default(8_788),
  PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64: z.string().trim().min(1).max(256),
  PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: z.string().trim().min(1).max(128),
  PUBLIC_VERIFICATION_RATE_LIMIT: positiveInteger(30),
  PUBLIC_VERIFICATION_PEER_LIMIT: positiveInteger(120),
  PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS: positiveInteger(60),
});

export interface PublicVerificationProcessConfig {
  readonly host: string;
  readonly port: number;
  readonly publicKey: Buffer;
  readonly rateLimitPepper: Buffer;
  readonly rateLimitPolicy: {
    readonly limit: number;
    readonly peerLimit: number;
    readonly windowSeconds: number;
  };
}

export class PublicVerificationRuntimeConfigError extends Error {
  override readonly name = "PublicVerificationRuntimeConfigError";
}

function decodeCanonicalBase64(name: string, value: string, maxBytes: number): Buffer {
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > maxBytes ||
    decoded.toString("base64") !== encoded
  ) {
    throw new PublicVerificationRuntimeConfigError(`${name} must be canonical base64`);
  }
  return decoded;
}

function decodeEd25519PublicKey(value: string): Buffer {
  const decoded = decodeCanonicalBase64("PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64", value, 128);
  try {
    const key = createPublicKey({ key: decoded, format: "der", type: "spki" });
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("unexpected key type");
    }
  } catch {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64 must encode an Ed25519 SPKI DER public key",
    );
  }
  return decoded;
}

function decodeRateLimitPepper(value: string): Buffer {
  const decoded = decodeCanonicalBase64("PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64", value, 32);
  if (decoded.byteLength !== 32) {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64 must encode exactly 32 bytes",
    );
  }
  return decoded;
}

export function loadPublicVerificationRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublicVerificationProcessConfig {
  const parsed = runtimeSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new PublicVerificationRuntimeConfigError(
      `Invalid public verification runtime configuration: ${issues}`,
    );
  }

  return {
    host: parsed.data.PUBLIC_VERIFICATION_HOST,
    port: parsed.data.PUBLIC_VERIFICATION_PORT,
    publicKey: decodeEd25519PublicKey(parsed.data.PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64),
    rateLimitPepper: decodeRateLimitPepper(
      parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64,
    ),
    rateLimitPolicy: {
      limit: parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT,
      peerLimit: parsed.data.PUBLIC_VERIFICATION_PEER_LIMIT,
      windowSeconds: parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS,
    },
  };
}
