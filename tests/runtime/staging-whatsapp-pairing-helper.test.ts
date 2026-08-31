import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStagingWhatsAppPairingCheckout,
  buildStagingWhatsAppPairingPlan,
  buildSupabaseRuntimeJitDatabaseUrl,
  loadOrCreateStagingWhatsAppLocalSecrets,
  StagingWhatsAppPairingHelperConfigError,
} from "../../src/operations/staging-whatsapp-pairing-helper.js";

const REVISION = "a".repeat(40);
const PROJECT_REF = "abcdefghijklmnopqrst";
const POOLER_HOST = "aws-0-sa-east-1.pooler.supabase.com";
const JIT_TOKEN = "jit-token-never-log-this";

describe("staging WhatsApp pairing helper", () => {
  it("builds a verify-full Supabase JIT URL for pokemon_runtime only", () => {
    const databaseUrl = buildSupabaseRuntimeJitDatabaseUrl({
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
      jitToken: JIT_TOKEN,
    });
    const parsed = new URL(databaseUrl);

    expect(parsed.username).toBe(`pokemon_runtime.${PROJECT_REF}`);
    expect(parsed.password).toBe(JIT_TOKEN);
    expect(parsed.hostname).toBe(POOLER_HOST);
    expect(parsed.port).toBe("5432");
    expect(parsed.pathname).toBe("/postgres");
    expect(parsed.searchParams.get("sslmode")).toBe("verify-full");
    expect(parsed.searchParams.get("options")).toBe("-c jit=true");
    expect(databaseUrl).not.toContain("pokemon_migrator");
  });

  it("creates one 32-byte auth key and reuses the same local secret on replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pokemon-pairing-helper-"));
    const filePath = join(directory, "staging-whatsapp.json");

    const first = await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath,
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
    });
    const second = await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath,
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(Buffer.from(first.secrets.authKeyBase64, "base64")).toHaveLength(32);
    expect(second.secrets.authKeyBase64).toBe(first.secrets.authKeyBase64);
    expect(second.secrets.sessionKey).toBe("pokemon-staging");
    expect(second.secrets.authKeyVersion).toBe(1);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("jitToken");
    expect(persisted).not.toHaveProperty("databaseUrl");

    if (process.platform !== "win32") {
      const metadata = await stat(filePath);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed when a persisted secret belongs to a different staging database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pokemon-pairing-helper-mismatch-"));
    const filePath = join(directory, "staging-whatsapp.json");

    await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath,
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
    });

    await expect(
      loadOrCreateStagingWhatsAppLocalSecrets({
        filePath,
        projectRef: "bbbbbbbbbbbbbbbbbbbb",
        poolerHost: POOLER_HOST,
      }),
    ).rejects.toBeInstanceOf(StagingWhatsAppPairingHelperConfigError);
  });

  it("pins the execution to a clean main checkout with a full commit revision", () => {
    expect(() =>
      assertStagingWhatsAppPairingCheckout({
        branch: "main",
        revision: REVISION,
        isClean: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertStagingWhatsAppPairingCheckout({
        branch: "feature/not-main",
        revision: REVISION,
        isClean: true,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);
    expect(() =>
      assertStagingWhatsAppPairingCheckout({
        branch: "main",
        revision: REVISION,
        isClean: false,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);
    expect(() =>
      assertStagingWhatsAppPairingCheckout({
        branch: "main",
        revision: "short-sha",
        isClean: true,
      }),
    ).toThrow(StagingWhatsAppPairingHelperConfigError);
  });

  it("produces a staging-only child environment while keeping secrets out of public status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pokemon-pairing-helper-plan-"));
    const filePath = join(directory, "staging-whatsapp.json");
    const { secrets } = await loadOrCreateStagingWhatsAppLocalSecrets({
      filePath,
      projectRef: PROJECT_REF,
      poolerHost: POOLER_HOST,
    });

    const plan = buildStagingWhatsAppPairingPlan({
      revision: REVISION,
      jitToken: JIT_TOKEN,
      caPath: "/trusted/repo/certs/supabase/prod-ca-2021.crt",
      secrets,
    });

    expect(plan.env.APP_ENV).toBe("staging");
    expect(plan.env.DEPLOY_REVISION).toBe(REVISION);
    expect(plan.env.WHATSAPP_SESSION_KEY).toBe("pokemon-staging");
    expect(plan.env.WHATSAPP_AUTH_KEY_VERSION).toBe("1");
    expect(Buffer.from(plan.env.WHATSAPP_AUTH_KEY_BASE64 ?? "", "base64")).toHaveLength(32);
    expect(plan.env.NODE_EXTRA_CA_CERTS).toBe("/trusted/repo/certs/supabase/prod-ca-2021.crt");
    expect(plan.env.DATABASE_URL).toContain(`pokemon_runtime.${PROJECT_REF}`);

    const publicText = JSON.stringify(plan.publicSummary);
    expect(publicText).not.toContain(JIT_TOKEN);
    expect(publicText).not.toContain(secrets.authKeyBase64);
    expect(publicText).not.toContain(plan.env.DATABASE_URL);
    expect(publicText).toContain("pokemon-staging");
    expect(publicText).toContain(REVISION);
  });
});
