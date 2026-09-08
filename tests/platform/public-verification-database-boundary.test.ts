import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { loadPublicVerificationRuntimeConfig } from "../../src/runtime/public-verification-runtime-config.js";

const PUBLIC_KEY = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "der", type: "pkcs8" },
  publicKeyEncoding: { format: "der", type: "spki" },
}).publicKey;

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PUBLIC_VERIFICATION_DATABASE_URL:
      "postgresql://pokemon_public_verification:test-only@localhost:5432/pokemon_rpg_test",
    PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64: PUBLIC_KEY.toString("base64"),
    PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: Buffer.alloc(32, 29).toString("base64"),
  };
}

describe("public verification database least-privilege boundary", () => {
  it("requires a dedicated PostgreSQL URL and keeps the worker DATABASE_URL out of the public entrypoint", async () => {
    const config = loadPublicVerificationRuntimeConfig(baseEnv());
    expect(Reflect.get(config, "databaseUrl")).toBe(
      baseEnv().PUBLIC_VERIFICATION_DATABASE_URL,
    );

    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        PUBLIC_VERIFICATION_DATABASE_URL: undefined,
        DATABASE_URL: "postgresql://pokemon_runtime:wrong-role@localhost:5432/pokemon_rpg_test",
      }),
    ).toThrow(/PUBLIC_VERIFICATION_DATABASE_URL|database/i);

    const publicMain = await readFile(
      new URL("../../src/public-verification-main.ts", import.meta.url),
      "utf8",
    );
    expect(publicMain).not.toContain('from "./platform/config/env.js"');
    expect(publicMain).not.toContain("appConfig.databaseUrl");
    expect(publicMain).toContain("publicConfig.databaseUrl");
  });
});
