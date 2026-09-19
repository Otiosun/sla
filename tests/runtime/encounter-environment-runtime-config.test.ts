import { describe, expect, it } from "vitest";
import {
  EncounterEnvironmentRuntimeConfigError,
  resolveNarratorEncounterEnvironment,
} from "../../src/runtime/encounter-environment-runtime-config.js";

describe("narrator encounter environment runtime config", () => {
  it("maps explicit semantic DAY/NIGHT without inventing numeric hours", () => {
    expect(
      resolveNarratorEncounterEnvironment({
        BELL_WORLD_TIME_OF_DAY: "day",
      }),
    ).toEqual({
      timeOfDay: "DAY",
      surface: "LAND",
      rarity: "COMMON",
    });

    expect(
      resolveNarratorEncounterEnvironment({
        BELL_WORLD_TIME_OF_DAY: "NIGHT",
        BELL_WORLD_WEATHER_KEY: "mist",
      }),
    ).toEqual({
      timeOfDay: "NIGHT",
      surface: "LAND",
      rarity: "COMMON",
      weatherKey: "mist",
    });
  });

  it("fails closed when semantic time-of-day is absent or invalid", () => {
    expect(() => resolveNarratorEncounterEnvironment({})).toThrow(
      EncounterEnvironmentRuntimeConfigError,
    );
    expect(() =>
      resolveNarratorEncounterEnvironment({
        BELL_WORLD_TIME_OF_DAY: "18:00",
      }),
    ).toThrow(EncounterEnvironmentRuntimeConfigError);
  });
});
