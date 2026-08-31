import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStagingRuntimeJitUrl,
  createStagingPairingBootstrapArgs,
  createStagingWhatsAppPairingEnvironment,
  generateWhatsAppAuthKeyBase64,
  serializeStagingPairingLocalSecrets,
  StagingWhatsAppPairingHelperConfigError,
} from "../../src/operations/staging-whatsapp-pairing-helper.js";

const PROJECT_REF = "abcdefghijklmnopqrst";
const POOLER_HOST = "aws-0-sa-east-1.pooler.supabase.com";
const REVISION = "a".repeat(40);
const JIT_TOKEN = "temporary-jit-token/+?=";
const AUTH_KEY = Buffer.alloc(32, 0x6b).toString("base64");
const CA_PATH = "C:\\pokemon-rpg\\certs\\supabase\\prod-ca-2021.crt";

describe("zero-cost staging WhatsApp pairing helper", () => {
  it("builds a verify-full Supabase JIT URL fixed to pokemon_runtime", () => {
    const connectionString = buildStagingRuntimeJitUrl({
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
      jitToken: JIT_TOKEN,
    });
    const url = new URL(connectionString);

    expect(url.protocol).toBe("postgresql:");
    expect(url.username).toBe(`pokemon_runtime.${PROJECT_REF}`);
    expect(decodeURIComponent(url.password)).toBe(JIT_TOKEN);
    expect(url.hostname).toBe(POOLER_HOST);
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/postgres");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("options")).toBe("-c jit=true");
  });

  it("creates a host-agnostic staging environment without migrator or raw JIT authority", () => {
    const env = createStagingWhatsAppPairingEnvironment({
      baseEnv: {
        PATH: "C:\\Windows\\System32",
        MIGRATOR_DATABASE_URL: "postgresql://must-not-survive",
        FLY_API_TOKEN: "must-not-be-needed",
        STAGING_SUPABASE_PROJECT_REF: PROJECT_REF,
        STAGING_SUPABASE_POOLER_HOST: POOLER_HOST,
        STAGING_SUPABASE_JIT_TOKEN: JIT_TOKEN,
      },
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
      jitToken: JIT_TOKEN,
      deploymentRevision: REVISION,
      authKeyBase64: AUTH_KEY,
      caPath: CA_PATH,
    });

    expect(env.APP_ENV).toBe("staging");
    expect(env.DEPLOY_REVISION).toBe(REVISION);
    expect(env.WHATSAPP_SESSION_KEY).toBe("pokemon-staging");
    expect(env.WHATSAPP_AUTH_KEY_BASE64).toBe(AUTH_KEY);
    expect(env.WHATSAPP_AUTH_KEY_VERSION).toBe("1");
    expect(env.DATABASE_URL).toContain(`pokemon_runtime.${PROJECT_REF}`);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(CA_PATH);
    expect(env.PGSSLROOTCERT).toBe(CA_PATH);
    expect(env.MIGRATOR_DATABASE_URL).toBeUndefined();
    expect(env.STAGING_SUPABASE_PROJECT_REF).toBeUndefined();
    expect(env.STAGING_SUPABASE_POOLER_HOST).toBeUndefined();
    expect(env.STAGING_SUPABASE_JIT_TOKEN).toBeUndefined();
    expect(env.FLY_API_TOKEN).toBeUndefined();
    expect(env.RENDER_API_KEY).toBeUndefined();
    expect(env.RAILWAY_TOKEN).toBeUndefined();
  });

  it("generates canonical base64 for exactly 32 random bytes", () => {
    const generated = generateWhatsAppAuthKeyBase64((size: number) => Buffer.alloc(size, 0xa5));
    const decoded = Buffer.from(generated, "base64");

    expect(decoded).toHaveLength(32);
    expect(decoded.toString("base64")).toBe(generated);
  });

  it("serializes only the persistent local WhatsApp secret and never JIT/database material", () => {
    const serialized = serializeStagingPairingLocalSecrets(AUTH_KEY);

    expect(serialized).toContain("WHATSAPP_SESSION_KEY=pokemon-staging");
    expect(serialized).toContain(`WHATSAPP_AUTH_KEY_BASE64=${AUTH_KEY}`);
    expect(serialized).toContain("WHATSAPP_AUTH_KEY_VERSION=1");
    expect(serialized).not.toContain(JIT_TOKEN);
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("STAGING_SUPABASE_JIT_TOKEN");
  });

  it("invokes only the canonical local bootstrap through a Node child process", () => {
    expect(createStagingPairingBootstrapArgs()).toEqual([
      "--import",
      "tsx",
      "scripts/operations/bootstrap-whatsapp-session.ts",
    ]);
  });

  it("exposes one local staging pairing command that reloads the ignored secret file", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(pkg.scripts?.["ops:bootstrap:whatsapp:staging"]).toBe(
      "node --env-file-if-exists=.env.whatsapp-staging.local --import tsx scripts/operations/staging-whatsapp-pairing-helper.ts",
    );
  });

  it("fails closed for malformed staging identity, revision or auth key", () => {
    expect(() =>
      buildStagingRuntimeJitUrl({
        projectRef: "wrong",
        poolerHost: POOLER_HOST,
        jitToken: JIT_TOKEN,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);

    expect(() =>
      buildStagingRuntimeJitUrl({
        projectRef: PROJECT_REF,
        poolerHost: "db.example.com",
        jitToken: JIT_TOKEN,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);

    expect(() =>
      createStagingWhatsAppPairingEnvironment({
        baseEnv: {},
        projectRef: PROJECT_REF,
        poolerHost: POOLER_HOST,
        jitToken: JIT_TOKEN,
        deploymentRevision: "short",
        authKeyBase64: Buffer.alloc(31).toString("base64"),
        caPath: CA_PATH,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);
  });
});
