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
  now: Date = new Date(),
): EncounterEnvironmentContext {
  const configured = source.BELL_WORLD_TIME_OF_DAY?.trim().toUpperCase();
  if (configured !== undefined && configured.length > 0 && configured !== "DAY" && configured !== "NIGHT") {
    throw new EncounterEnvironmentRuntimeConfigError(
      "BELL_WORLD_TIME_OF_DAY must be DAY or NIGHT when explicitly configured",
    );
  }

  const localHour = now.getHours();
  const timeOfDay: "DAY" | "NIGHT" =
    configured === "DAY" || configured === "NIGHT"
      ? configured
      : localHour >= 6 && localHour < 18
        ? "DAY"
        : "NIGHT";

  const rawWeather = source.BELL_WORLD_WEATHER_KEY?.trim();
  return {
    timeOfDay,
    surface: "LAND",
    rarity: "COMMON",
    ...(rawWeather === undefined || rawWeather.length === 0 ? {} : { weatherKey: rawWeather }),
  };
}
