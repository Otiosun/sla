import { describe, expect, it } from "vitest";
import { loadPveBattleRuntimeConfig } from "../../src/runtime/pve-battle-runtime-config.js";

const rng = { encryptionKey: Buffer.alloc(32, 7), encryptionKeyVersion: 3 };

describe("PVE runtime configuration", () => {
  it("requires explicit opt-in and shares the encounter encryption key", () => {
    expect(loadPveBattleRuntimeConfig(rng, {})).toBeNull();
    expect(
      loadPveBattleRuntimeConfig(rng, {
        PVE_TURN_WINDOW_TTL_MS: "120000",
        PVE_MAINTENANCE_BATCH_SIZE: "4",
      }),
    ).toEqual({
      turnWindowTtlMs: 120000,
      maintenanceBatchSize: 4,
      encryptionKeys: new Map([[3, rng.encryptionKey]]),
    });
  });

  it.each([undefined, "", "0", "-1", "1.5", "1e3", " 5", "9007199254740992"])(
    "rejects partial or invalid configuration (%s)",
    (value) => {
      expect(() =>
        loadPveBattleRuntimeConfig(rng, {
          PVE_TURN_WINDOW_TTL_MS: value,
          PVE_MAINTENANCE_BATCH_SIZE: "4",
        }),
      ).toThrow("PVE_TURN_WINDOW_TTL_MS");
      expect(() =>
        loadPveBattleRuntimeConfig(rng, {
          PVE_TURN_WINDOW_TTL_MS: "120000",
          PVE_MAINTENANCE_BATCH_SIZE: value,
        }),
      ).toThrow("PVE_MAINTENANCE_BATCH_SIZE");
    },
  );
});
