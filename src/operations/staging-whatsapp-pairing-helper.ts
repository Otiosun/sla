import { randomBytes } from "node:crypto";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const POOLER_HOST_PATTERN = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const DEPLOY_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const STAGING_SESSION_KEY = "pokemon-staging";
const HOSTING_ENV_KEYS = ["FLY_API_TOKEN", "RENDER_API_KEY", "RAILWAY_TOKEN"] as const;

export class StagingWhatsAppPairingHelperConfigError extends Error {
  override readonly name = "StagingWhatsAppPairingHelperConfigError";
}

interface StagingRuntimeJitInput {
  readonly projectRef: string;
  readonly poolerHost: string;
  readonly jitToken: string;
}

interface StagingWhatsAppPairingEnvironmentInput extends StagingRuntimeJitInput {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly deploymentRevision: string;
  readonly authKeyBase64: string;
  readonly caPath: string;
}

export type RandomBytesFactory = (size: number) => Uint8Array;

function assertStagingRuntimeJitInput(input: StagingRuntimeJitInput): void {
  if (!PROJECT_REF_PATTERN.test(input.projectRef)) {
    throw new StagingWhatsAppPairingHelperConfigError("Supabase staging project ref is invalid");
  }
  if (!POOLER_HOST_PATTERN.test(input.poolerHost)) {
    throw new StagingWhatsAppPairingHelperConfigError("Supabase staging pooler host is invalid");
  }
  if (input.jitToken.length === 0) {
    throw new StagingWhatsAppPairingHelperConfigError("Supabase staging JIT token is required");
  }
}

function assertCanonicalAuthKey(value: string): void {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "WhatsApp auth encryption key must be canonical base64 for exactly 32 bytes",
    );
  }
}

export function buildStagingRuntimeJitUrl(input: StagingRuntimeJitInput): string {
  assertStagingRuntimeJitInput(input);

  const username = `pokemon_runtime.${input.projectRef}`;
  const url = new URL(`postgresql://${input.poolerHost}:5432/postgres`);
  url.username = username;
  url.password = input.jitToken;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("options", "-c jit=true");
  return url.toString();
}

export function generateWhatsAppAuthKeyBase64(
  randomBytesFactory: RandomBytesFactory = randomBytes,
): string {
  const generated = Buffer.from(randomBytesFactory(32));
  if (generated.length !== 32) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "WhatsApp auth encryption key generator did not return exactly 32 bytes",
    );
  }
  return generated.toString("base64");
}

export function createStagingWhatsAppPairingEnvironment(
  input: StagingWhatsAppPairingEnvironmentInput,
): NodeJS.ProcessEnv {
  if (!DEPLOY_REVISION_PATTERN.test(input.deploymentRevision)) {
    throw new StagingWhatsAppPairingHelperConfigError("Deployment revision must be a full Git SHA");
  }
  if (input.caPath.trim().length === 0) {
    throw new StagingWhatsAppPairingHelperConfigError("Supabase root CA path is required");
  }
  assertCanonicalAuthKey(input.authKeyBase64);

  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  delete env.MIGRATOR_DATABASE_URL;
  for (const key of HOSTING_ENV_KEYS) delete env[key];

  env.APP_ENV = "staging";
  env.DATABASE_URL = buildStagingRuntimeJitUrl(input);
  env.DEPLOY_REVISION = input.deploymentRevision;
  env.WHATSAPP_SESSION_KEY = STAGING_SESSION_KEY;
  env.WHATSAPP_AUTH_KEY_BASE64 = input.authKeyBase64;
  env.WHATSAPP_AUTH_KEY_VERSION = "1";
  env.NODE_EXTRA_CA_CERTS = input.caPath;
  env.PGSSLROOTCERT = input.caPath;
  return env;
}
