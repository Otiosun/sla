import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EncounterRngRuntimeConfigError,
  loadEncounterRngRuntimeConfig,
} from "../../src/runtime/encounter-rng-runtime-config.js";

describe("Encounter RNG runtime configuration", () => {
  it("loads a canonical 32-byte base64 key with a positive key version", () => {
    const key = randomBytes(32);
    const config = loadEncounterRngRuntimeConfig({
      ENCOUNTER_RNG_KEY_BASE64: key.toString("base64"),
      ENCOUNTER_RNG_KEY_VERSION: "7",
    });

    expect(config.encryptionKey).toEqual(key);
    expect(config.encryptionKeyVersion).toBe(7);
  });

  it("fails fast when the key is absent, malformed, non-canonical or not exactly 32 bytes", () => {
    expect(() => loadEncounterRngRuntimeConfig({})).toThrow(EncounterRngRuntimeConfigError);
    expect(() =>
      loadEncounterRngRuntimeConfig({
        ENCOUNTER_RNG_KEY_BASE64: randomBytes(16).toString("base64"),
      }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      loadEncounterRngRuntimeConfig({
        ENCOUNTER_RNG_KEY_BASE64: `${randomBytes(32).toString("base64")}\n`,
      }),
    ).toThrow(/canonical base64/);
  });

  it("rejects non-positive or non-integer key versions", () => {
    const key = randomBytes(32).toString("base64");
    for (const version of ["0", "-1", "1.5", "not-a-number"]) {
      expect(() =>
        loadEncounterRngRuntimeConfig({
          ENCOUNTER_RNG_KEY_BASE64: key,
          ENCOUNTER_RNG_KEY_VERSION: version,
        }),
      ).toThrow(EncounterRngRuntimeConfigError);
    }
  });
});
