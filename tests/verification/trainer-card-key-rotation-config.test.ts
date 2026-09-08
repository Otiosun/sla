import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPublicVerificationRuntimeConfig } from "../../src/runtime/public-verification-runtime-config.js";

function publicKeyDer(): Buffer {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  }).publicKey;
}

const CURRENT_PUBLIC_KEY = publicKeyDer();
const PREVIOUS_PUBLIC_KEY_A = publicKeyDer();
const PREVIOUS_PUBLIC_KEY_B = publicKeyDer();
const PREVIOUS_PUBLIC_KEY_C = publicKeyDer();
const PREVIOUS_PUBLIC_KEY_D = publicKeyDer();
const RATE_LIMIT_PEPPER = Buffer.alloc(32, 17).toString("base64");
const DATABASE_URL =
  "postgresql://pokemon_public_verifier:test-only-password@localhost:5432/pokemon_rpg_test";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PUBLIC_VERIFICATION_DATABASE_URL: DATABASE_URL,
    PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64: CURRENT_PUBLIC_KEY.toString("base64"),
    PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: RATE_LIMIT_PEPPER,
  };
}

describe("public verification Ed25519 key rotation config", () => {
  it("loads a bounded keyring of previous public keys", () => {
    const config = loadPublicVerificationRuntimeConfig({
      ...baseEnv(),
      PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: [
        PREVIOUS_PUBLIC_KEY_A,
        PREVIOUS_PUBLIC_KEY_B,
      ]
        .map((key) => key.toString("base64"))
        .join(","),
    });

    expect(Reflect.get(config, "previousPublicKeys")).toEqual([
      PREVIOUS_PUBLIC_KEY_A,
      PREVIOUS_PUBLIC_KEY_B,
    ]);
  });

  it("defaults the previous-key ring to empty", () => {
    const config = loadPublicVerificationRuntimeConfig(baseEnv());
    expect(Reflect.get(config, "previousPublicKeys")).toEqual([]);
  });

  it("fails closed on malformed, duplicate, current-key, or oversized previous-key rings", () => {
    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: "not-canonical-base64",
      }),
    ).toThrow(/previous|Ed25519|base64/i);

    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: [
          PREVIOUS_PUBLIC_KEY_A,
          PREVIOUS_PUBLIC_KEY_A,
        ]
          .map((key) => key.toString("base64"))
          .join(","),
      }),
    ).toThrow(/duplicate|previous/i);

    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: CURRENT_PUBLIC_KEY.toString("base64"),
      }),
    ).toThrow(/current|duplicate|previous/i);

    expect(() =>
      loadPublicVerificationRuntimeConfig({
        ...baseEnv(),
        PUBLIC_VERIFICATION_PREVIOUS_PUBLIC_KEYS_BASE64: [
          PREVIOUS_PUBLIC_KEY_A,
          PREVIOUS_PUBLIC_KEY_B,
          PREVIOUS_PUBLIC_KEY_C,
          PREVIOUS_PUBLIC_KEY_D,
        ]
          .map((key) => key.toString("base64"))
          .join(","),
      }),
    ).toThrow(/previous|3|three|limit/i);
  });
});
