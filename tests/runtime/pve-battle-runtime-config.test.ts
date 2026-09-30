import { describe, expect, it } from "vitest";
import { loadPveBattleRuntimeConfig } from "../../src/runtime/pve-battle-runtime-config.js";

const rng = { encryptionKey: Buffer.alloc(32, 7), encryptionKeyVersion: 3 };

describe("PVE runtime configuration", () => {
  it("is enabled by default and shares the encounter encryption key", () => {
    expect(loadPveBattleRuntimeConfig(rng, {})).toEqual({
      turnWindowTtlMs: 604_800_000,
      maintenanceBatchSize: 25,
      encryptionKeys: new Map([[3, rng.encryptionKey]]),
    });
  });

  it("accepts explicit overrides independently", () => {
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
    expect(
      loadPveBattleRuntimeConfig(rng, {
        PVE_MAINTENANCE_BATCH_SIZE: "8",
      }),
    ).toEqual({
      turnWindowTtlMs: 604_800_000,
      maintenanceBatchSize: 8,
      encryptionKeys: new Map([[3, rng.encryptionKey]]),
    });
  });

  it.each(["", "0", "-1", "1.5", "1e3", " 5", "9007199254740992"])(
    "rejects invalid explicit configuration (%s)",
    (value) => {
      expect(() =>
        loadPveBattleRuntimeConfig(rng, {
          PVE_TURN_WINDOW_TTL_MS: value,
        }),
      ).toThrow("PVE_TURN_WINDOW_TTL_MS");
      expect(() =>
        loadPveBattleRuntimeConfig(rng, {
          PVE_MAINTENANCE_BATCH_SIZE: value,
        }),
      ).toThrow("PVE_MAINTENANCE_BATCH_SIZE");
    },
  );
});
