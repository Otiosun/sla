import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createStagingPairingBootstrapArgs,
  createStagingWhatsAppPairingEnvironment,
  generateWhatsAppAuthKeyBase64,
  serializeStagingPairingLocalSecrets,
  StagingWhatsAppPairingHelperConfigError,
} from "../../src/operations/staging-whatsapp-pairing-helper.js";

const LOCAL_SECRET_FILE = ".env.whatsapp-staging.local";
const CA_RELATIVE_PATH = "certs/supabase/prod-ca-2021.crt";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new StagingWhatsAppPairingHelperConfigError(`${name} is required`);
  }
  return value;
}

function gitOutput(args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Git metadata is unavailable; run this command from a clean repository checkout",
    );
  }
}

function assertCleanCheckout(): string {
  const revision = gitOutput(["rev-parse", "HEAD"]);
  const dirty = gitOutput(["status", "--porcelain"]);
  if (dirty.length !== 0) {
    throw new StagingWhatsAppPairingHelperConfigError(
      "Local repository has uncommitted changes; first pairing requires a clean release-bound checkout",
    );
  }
  return revision;
}

function loadOrCreateAuthKey(secretPath: string): string {
  const existing = process.env.WHATSAPP_AUTH_KEY_BASE64;
  if (existing !== undefined && existing.length > 0) return existing;

  if (existsSync(secretPath)) {
    throw new StagingWhatsAppPairingHelperConfigError(
      `${LOCAL_SECRET_FILE} exists but WHATSAPP_AUTH_KEY_BASE64 was not loaded; refusing to overwrite it`,
    );
  }

  const generated = generateWhatsAppAuthKeyBase64();
  writeFileSync(secretPath, serializeStagingPairingLocalSecrets(generated), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `Created ${LOCAL_SECRET_FILE} with the local staging WhatsApp encryption key. Keep this gitignored file private.\n`,
  );
  return generated;
}

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || process.env.CI !== undefined) {
  throw new StagingWhatsAppPairingHelperConfigError(
    "Staging WhatsApp pairing requires a local interactive terminal and is blocked in CI",
  );
}

const repoRoot = process.cwd();
const caPath = resolve(repoRoot, CA_RELATIVE_PATH);
if (!existsSync(caPath)) {
  throw new StagingWhatsAppPairingHelperConfigError(
    `Supabase root CA is missing at ${CA_RELATIVE_PATH}`,
  );
}

const deploymentRevision = assertCleanCheckout();
const secretPath = resolve(repoRoot, LOCAL_SECRET_FILE);
const authKeyBase64 = loadOrCreateAuthKey(secretPath);
const childEnv = createStagingWhatsAppPairingEnvironment({
  baseEnv: process.env,
  projectRef: requiredEnv("STAGING_SUPABASE_PROJECT_REF"),
  poolerHost: requiredEnv("STAGING_SUPABASE_POOLER_HOST"),
  jitToken: requiredEnv("STAGING_SUPABASE_JIT_TOKEN"),
  deploymentRevision,
  authKeyBase64,
  caPath,
});

process.stdout.write(
  "Starting host-agnostic staging WhatsApp first pairing. The QR will remain in this terminal only.\n",
);
const result = spawnSync(process.execPath, [...createStagingPairingBootstrapArgs()], {
  cwd: repoRoot,
  env: childEnv,
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw new Error("Staging WhatsApp pairing process could not be started");
}
if (result.status !== 0) {
  throw new Error(`Staging WhatsApp pairing failed with exit code ${String(result.status)}`);
}

process.stdout.write("Staging WhatsApp pairing helper completed successfully.\n");
