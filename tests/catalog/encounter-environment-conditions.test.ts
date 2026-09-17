import { describe, expect, it } from "vitest";
import {
  encounterConditionsAllow,
  parseEncounterConditions,
} from "../../src/modules/catalog/encounter-contracts.js";

describe("encounter environmental conditions", () => {
  it("keeps legacy unlock-only behavior compatible", () => {
    const parsed = parseEncounterConditions({
      schemaVersion: 1,
      requiredUnlockKeys: ["story.open"],
      blockedUnlockKeys: [],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(encounterConditionsAllow(parsed.data, new Set(["story.open"]))).toBe(true);
  });

  it("fails closed when an environmental requirement exists but context is absent", () => {
    const parsed = parseEncounterConditions({
      schemaVersion: 1,
      requiredUnlockKeys: [],
      blockedUnlockKeys: [],
      timeOfDay: "NIGHT",
      surface: "LAND",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(encounterConditionsAllow(parsed.data, new Set())).toBe(false);
    expect(
      encounterConditionsAllow(parsed.data, new Set(), {
        timeOfDay: "NIGHT",
        surface: "LAND",
      }),
    ).toBe(true);
    expect(
      encounterConditionsAllow(parsed.data, new Set(), {
        timeOfDay: "DAY",
        surface: "LAND",
      }),
    ).toBe(false);
  });

  it("matches rarity and weather only when explicitly supplied", () => {
    const parsed = parseEncounterConditions({
      schemaVersion: 1,
      requiredUnlockKeys: [],
      blockedUnlockKeys: [],
      rarity: "RARE",
      weatherKey: "weather.rain",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      encounterConditionsAllow(parsed.data, new Set(), {
        rarity: "RARE",
        weatherKey: "weather.rain",
      }),
    ).toBe(true);
    expect(
      encounterConditionsAllow(parsed.data, new Set(), {
        rarity: "COMMON",
        weatherKey: "weather.rain",
      }),
    ).toBe(false);
  });
});
