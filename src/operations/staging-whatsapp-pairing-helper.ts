import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const POOLER_HOST_PATTERN = /^(?:[a-z0-9-]+\.)+pooler\.supabase\.com$/;
const FULL_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const LOCAL_SECRET_VERSION = 1;
const STAGING_SESSION_KEY = "pokemon-staging";
const STAGING_AUTH_KEY_VERSION = 1;
const RUNTIME_ROLE = "pokemon_runtime";

export class StagingWhatsAppPairingHelperConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingWhatsAppPairingHelperConfigError";
  }
}

export interface StagingWhatsAppLocalSecrets {
  version: 1;
  projectRef: string;
  poolerHost: string;
  sessionKey: string;
  authKeyBase64: string;
  authKeyVersion: 1;
}

function assertProjectRef(projectRef: string): void {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Supabase staging project ref must be exactly 20 lowercase alphanumeric characters",
    );
  }
}

function assertPoolerHost(poolerHost: string): void {
  if (!POOLER_HOST_PATTERN.test(poolerHost)) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Supabase staging pooler host must be a pooler.supabase.com hostname",
    );
  }
}

function assertJitToken(jitToken: string): void {
  if (jitToken.trim().length === 0) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Supabase Temporary Access token is required",
    );
  }
}

function assertCanonicalAuthKey(authKeyBase64: string): void {
  const decoded = Buffer.from(authKeyBase64, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== authKeyBase64) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Persisted WhatsApp auth encryption key must be canonical base64 for exactly 32 bytes",
    );
  }
}

function parsePersistedSecrets(raw: string): StagingWhatsAppLocalSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Local staging WhatsApp secret file is not valid JSON",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Local staging WhatsApp secret file has an invalid shape",
    );
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== LOCAL_SECRET_VERSION ||
    typeof candidate.projectRef !== "string" ||
    typeof candidate.poolerHost !== "string" ||
    candidate.sessionKey !== STAGING_SESSION_KEY ||
    typeof candidate.authKeyBase64 !== "string" ||
    candidate.authKeyVersion !== STAGING_AUTH_KEY_VERSION
  ) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Local staging WhatsApp secret file does not match the supported schema",
    );
  }

  assertProjectRef(candidate.projectRef);
  assertPoolerHost(candidate.poolerHost);
  assertCanonicalAuthKey(candidate.authKeyBase64);

  return {
    version: LOCAL_SECRET_VERSION,
    projectRef: candidate.projectRef,
    poolerHost: candidate.poolerHost,
    sessionKey: STAGING_SESSION_KEY,
    authKeyBase64: candidate.authKeyBase64,
    authKeyVersion: STAGING_AUTH_KEY_VERSION,
  };
}

async function hardenLocalSecretPermissions(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}

export function buildSupabaseRuntimeJitDatabaseUrl(input: {
  projectRef: string;
  poolerHost: string;
  jitToken: string;
}): string {
  assertProjectRef(input.projectRef);
  assertPoolerHost(input.poolerHost);
  assertJitToken(input.jitToken);

  const url = new URL("postgresql://localhost/postgres");
  url.username = `${RUNTIME_ROLE}.${input.projectRef}`;
  url.password = input.jitToken;
  url.hostname = input.poolerHost;
  url.port = "5432";
  url.pathname = "/postgres";
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("options", "-c jit=true");
  return url.toString();
}

export async function readStagingWhatsAppLocalSecrets(input: {
  filePath: string;
}): Promise<StagingWhatsAppLocalSecrets | null> {
  try {
    const existing = parsePersistedSecrets(await readFile(input.filePath, "utf8"));
    await hardenLocalSecretPermissions(input.filePath);
    return existing;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadOrCreateStagingWhatsAppLocalSecrets(input: {
  filePath: string;
  projectRef: string;
  poolerHost: string;
}): Promise<{ secrets: StagingWhatsAppLocalSecrets; created: boolean }> {
  assertProjectRef(input.projectRef);
  assertPoolerHost(input.poolerHost);

  const existing = await readStagingWhatsAppLocalSecrets({ filePath: input.filePath });
  if (existing) {
    if (existing.projectRef !== input.projectRef || existing.poolerHost !== input.poolerHost) {
      throw new StagingWhatsAppPairingHelperConfigError(
        "Local staging WhatsApp secret file belongs to a different Supabase staging database",
      );
    }
    return { secrets: existing, created: false };
  }

  const secrets: StagingWhatsAppLocalSecrets = {
    version: LOCAL_SECRET_VERSION,
    projectRef: input.projectRef,
    poolerHost: input.poolerHost,
    sessionKey: STAGING_SESSION_KEY,
    authKeyBase64: randomBytes(32).toString("base64"),
    authKeyVersion: STAGING_AUTH_KEY_VERSION,
  };

  await mkdir(dirname(input.filePath), { recursive: true, mode: 0o700 });
  await writeFile(input.filePath, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await hardenLocalSecretPermissions(input.filePath);
  return { secrets, created: true };
}

export function assertStagingWhatsAppPairingCheckout(input: {
  branch: string;
  revision: string;
  originMainRevision: string;
  isClean: boolean;
}): void {
  if (input.branch !== "main") {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Staging WhatsApp pairing helper must run from the main branch",
    );
  }
  if (
    !FULL_REVISION_PATTERN.test(input.revision) ||
    !FULL_REVISION_PATTERN.test(input.originMainRevision)
  ) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Staging WhatsApp pairing helper requires full 40-character local and origin/main revisions",
    );
  }
  if (!input.isClean) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Staging WhatsApp pairing helper requires a clean working tree",
    );
  }
  if (input.revision !== input.originMainRevision) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Local main is stale or diverged from origin/main; update the checkout before pairing",
    );
  }
}

export function buildStagingWhatsAppPairingPlan(input: {
  revision: string;
  jitToken: string;
  caPath: string;
  secrets: StagingWhatsAppLocalSecrets;
}): {
  env: NodeJS.ProcessEnv;
  publicSummary: {
    environment: "staging";
    databaseRole: "pokemon_runtime";
    tls: "verify-full";
    sessionKey: string;
    revision: string;
  };
} {
  if (!FULL_REVISION_PATTERN.test(input.revision)) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Staging WhatsApp pairing plan requires a full 40-character commit revision",
    );
  }
  if (input.caPath.trim().length === 0) {
    throw new StagingWhatsAppPairingHelperConfigError("Supabase CA path is required");
  }
  assertCanonicalAuthKey(input.secrets.authKeyBase64);

  const databaseUrl = buildSupabaseRuntimeJitDatabaseUrl({
    projectRef: input.secrets.projectRef,
    poolerHost: input.secrets.poolerHost,
    jitToken: input.jitToken,
  });

  return {
    env: {
      APP_ENV: "staging",
      DATABASE_URL: databaseUrl,
      DEPLOY_REVISION: input.revision,
      WHATSAPP_SESSION_KEY: input.secrets.sessionKey,
      WHATSAPP_AUTH_KEY_BASE64: input.secrets.authKeyBase64,
      WHATSAPP_AUTH_KEY_VERSION: String(input.secrets.authKeyVersion),
      NODE_EXTRA_CA_CERTS: input.caPath,
    },
    publicSummary: {
      environment: "staging",
      databaseRole: RUNTIME_ROLE,
      tls: "verify-full",
      sessionKey: input.secrets.sessionKey,
      revision: input.revision,
    },
  };
}
