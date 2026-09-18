import type { EncounterEnvironmentContext } from "../modules/catalog/encounter-contracts.js";

export class EncounterEnvironmentRuntimeConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EncounterEnvironmentRuntimeConfigError";
  }
}

export interface EncounterEnvironmentRuntimeSource {
  readonly BELL_WORLD_TIME_OF_DAY?: string;
  readonly BELL_WORLD_WEATHER_KEY?: string;
}

export function resolveNarratorEncounterEnvironment(
  source: EncounterEnvironmentRuntimeSource,
): EncounterEnvironmentContext {
  const rawTime = source.BELL_WORLD_TIME_OF_DAY?.trim().toUpperCase();
  if (rawTime !== "DAY" && rawTime !== "NIGHT") {
    throw new EncounterEnvironmentRuntimeConfigError(
      "BELL_WORLD_TIME_OF_DAY must be explicitly set to DAY or NIGHT",
    );
  }

  const rawWeather = source.BELL_WORLD_WEATHER_KEY?.trim();
  return {
    timeOfDay: rawTime,
    surface: "LAND",
    rarity: "COMMON",
    ...(rawWeather === undefined || rawWeather.length === 0 ? {} : { weatherKey: rawWeather }),
  };
}
