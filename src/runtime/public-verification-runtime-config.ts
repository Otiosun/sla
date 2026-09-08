import { createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const runtimeSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().trim().min(1).optional(),
  PUBLIC_VERIFICATION_DATABASE_URL: z.string().trim().min(1).max(4_096),
  DATABASE_POOL_MAX: positiveInteger(10),
  DATABASE_CONNECT_TIMEOUT_MS: positiveInteger(5_000),
  DATABASE_IDLE_TIMEOUT_MS: positiveInteger(30_000),
  DATABASE_QUERY_TIMEOUT_MS: positiveInteger(10_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(10_000),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: positiveInteger(15_000),
  PUBLIC_VERIFICATION_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  PUBLIC_VERIFICATION_PORT: z.coerce.number().int().min(1).max(65_535).default(8_788),
  PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64: z.string().trim().min(1).max(256),
  PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: z.string().trim().max(1_024).optional(),
  PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: z.string().trim().min(1).max(128),
  PUBLIC_VERIFICATION_RATE_LIMIT: positiveInteger(30),
  PUBLIC_VERIFICATION_PEER_LIMIT: positiveInteger(120),
  PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS: positiveInteger(60),
  PUBLIC_VERIFICATION_TRUSTED_PROXY_CIDRS: z.string().trim().max(2_048).optional(),
});

export interface PublicVerificationProcessConfig {
  readonly appEnv: "development" | "test" | "staging" | "production";
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseQueryTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly databaseIdleInTransactionTimeoutMs: number;
  readonly host: string;
  readonly port: number;
  readonly publicKey: Buffer;
  readonly previousPublicKeys: readonly Buffer[];
  readonly rateLimitPepper: Buffer;
  readonly trustedProxyCidrs: readonly string[];
  readonly rateLimitPolicy: {
    readonly limit: number;
    readonly peerLimit: number;
    readonly windowSeconds: number;
  };
}

export class PublicVerificationRuntimeConfigError extends Error {
  override readonly name = "PublicVerificationRuntimeConfigError";
}

function parsePostgresDatabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_DATABASE_URL must be a valid PostgreSQL URL",
    );
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.username.length === 0 ||
    url.hostname.length === 0 ||
    url.pathname.length <= 1
  ) {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_DATABASE_URL must identify a dedicated PostgreSQL database credential",
    );
  }

  return value;
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

function decodeEd25519PublicKey(name: string, value: string): Buffer {
  const decoded = decodeCanonicalBase64(name, value, 128);
  try {
    const key = createPublicKey({ key: decoded, format: "der", type: "spki" });
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("unexpected key type");
    }
    return key.export({ format: "der", type: "spki" });
  } catch {
    throw new PublicVerificationRuntimeConfigError(
      `${name} must encode an Ed25519 SPKI DER public key`,
    );
  }
}

function parsePreviousPublicKeys(
  value: string | undefined,
  currentPublicKey: Buffer,
): readonly Buffer[] {
  if (value === undefined || value.length === 0) return [];

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 3 || entries.some((entry) => entry.length === 0)) {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64 must contain 1 to 3 public keys",
    );
  }

  const previousPublicKeys = entries.map((entry) =>
    decodeEd25519PublicKey("PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64", entry),
  );
  const fingerprints = [currentPublicKey, ...previousPublicKeys].map((key) =>
    key.toString("base64"),
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new PublicVerificationRuntimeConfigError(
      "PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64 must not duplicate current or previous keys",
    );
  }

  return previousPublicKeys;
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

function parseTrustedProxyCidrs(value: string | undefined): readonly string[] {
  if (value === undefined || value.length === 0) return [];

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 32 || entries.some((entry) => entry.length === 0)) {
    throw new PublicVerificationRuntimeConfigError(
      "Public verification trusted proxy CIDRs must contain 1 to 32 explicit IP/CIDR entries",
    );
  }

  for (const entry of entries) {
    if (entry === "0.0.0.0/0" || entry === "::/0") {
      throw new PublicVerificationRuntimeConfigError(
        "Public verification trusted proxy CIDRs must not trust the entire internet",
      );
    }

    const parts = entry.split("/");
    if (parts.length > 2) {
      throw new PublicVerificationRuntimeConfigError(
        `Invalid public verification trusted proxy CIDR: ${entry}`,
      );
    }

    const address = parts[0] ?? "";
    const family = isIP(address);
    if (family === 0) {
      throw new PublicVerificationRuntimeConfigError(
        `Invalid public verification trusted proxy address: ${entry}`,
      );
    }

    const prefix = parts[1];
    if (prefix !== undefined) {
      if (!/^\d+$/.test(prefix)) {
        throw new PublicVerificationRuntimeConfigError(
          `Invalid public verification trusted proxy CIDR prefix: ${entry}`,
        );
      }
      const prefixLength = Number(prefix);
      const maximumPrefix = family === 4 ? 32 : 128;
      if (prefixLength < 0 || prefixLength > maximumPrefix) {
        throw new PublicVerificationRuntimeConfigError(
          `Invalid public verification trusted proxy CIDR prefix: ${entry}`,
        );
      }
    }
  }

  return [...new Set(entries)];
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

  if (parsed.data.DATABASE_URL !== undefined) {
    throw new PublicVerificationRuntimeConfigError(
      "Generic DATABASE_URL must not be present in the public verification runtime; use only PUBLIC_VERIFICATION_DATABASE_URL",
    );
  }

  const publicKey = decodeEd25519PublicKey(
    "PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64",
    parsed.data.PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64,
  );

  return {
    appEnv: parsed.data.APP_ENV,
    databaseUrl: parsePostgresDatabaseUrl(parsed.data.PUBLIC_VERIFICATION_DATABASE_URL),
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: parsed.data.DATABASE_CONNECT_TIMEOUT_MS,
    databaseIdleTimeoutMs: parsed.data.DATABASE_IDLE_TIMEOUT_MS,
    databaseQueryTimeoutMs: parsed.data.DATABASE_QUERY_TIMEOUT_MS,
    databaseStatementTimeoutMs: parsed.data.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseIdleInTransactionTimeoutMs: parsed.data.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    host: parsed.data.PUBLIC_VERIFICATION_HOST,
    port: parsed.data.PUBLIC_VERIFICATION_PORT,
    publicKey,
    previousPublicKeys: parsePreviousPublicKeys(
      parsed.data.PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64,
      publicKey,
    ),
    rateLimitPepper: decodeRateLimitPepper(
      parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64,
    ),
    trustedProxyCidrs: parseTrustedProxyCidrs(parsed.data.PUBLIC_VERIFICATION_TRUSTED_PROXY_CIDRS),
    rateLimitPolicy: {
      limit: parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT,
      peerLimit: parsed.data.PUBLIC_VERIFICATION_PEER_LIMIT,
      windowSeconds: parsed.data.PUBLIC_VERIFICATION_RATE_LIMIT_WINDOW_SECONDS,
    },
  };
}
