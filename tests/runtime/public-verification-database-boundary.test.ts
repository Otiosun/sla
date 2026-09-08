import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPublicVerificationRuntimeConfig } from "../../src/runtime/public-verification-runtime-config.js";

function publicKeyDer(): Buffer {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  }).publicKey;
}

const PUBLIC_KEY = publicKeyDer();
const RATE_LIMIT_PEPPER = Buffer.alloc(32, 41).toString("base64");
const DEDICATED_DATABASE_URL =
  "postgresql://pokemon_public_verifier:test-only-password@localhost:5432/pokemon_rpg_test";
const GENERIC_DATABASE_URL =
  "postgresql://pokemon_runtime:test-only-password@localhost:5432/pokemon_rpg_test";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64: PUBLIC_KEY.toString("base64"),
    PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: RATE_LIMIT_PEPPER,
  };
}

describe("public verification database authority boundary", () => {
  it("requires a dedicated public-verification database credential", () => {
    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        DATABASE_URL: GENERIC_DATABASE_URL,
      }),
    ).toThrow(/PUBLIC_VERIFICATION_DATABASE_URL|dedicated.*database/i);
  });

  it("refuses to start when a generic runtime database credential is also present", () => {
    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        DATABASE_URL: GENERIC_DATABASE_URL,
        PUBLIC_VERIFICATION_DATABASE_URL: DEDICATED_DATABASE_URL,
      }),
    ).toThrow(/DATABASE_URL.*must not|generic.*database/i);
  });

  it("loads only the dedicated database credential", () => {
    const config = loadPublicVerificationRuntimeConfig({
      ...baseEnv(),
      PUBLIC_VERIFICATION_DATABASE_URL: DEDICATED_DATABASE_URL,
    });

    expect(Reflect.get(config, "databaseUrl")).toBe(DEDICATED_DATABASE_URL);
  });
});
