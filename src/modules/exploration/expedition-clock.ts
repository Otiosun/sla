/**
 * Time policy for the planned solo expedition mode. No database writes,
 * WhatsApp routes or real-world timers are activated by this module.
 */
export type ExpeditionPeriod = "DAY" | "NIGHT";

export const EXPEDITION_WEEKLY_LIMIT = 3;
export const EXPEDITION_DURATION_MINUTES = 12 * 60;

export const EXPEDITION_ACTION_MINUTES = Object.freeze({
  SEARCH_POKEMON: 30,
  FOLLOW_TRACKS: 15,
  IGNORE_INCIDENTAL: 10,
  FINISH_BATTLE: 30,
  SEARCH_RESOURCES: 60,
  USE_POKEMON_CENTER: 30,
  VIEW_TEAM: 0,
  VIEW_INVENTORY: 0,
  CONSULT_ROTOMDEX: 0,
  USE_POKEMART: 0,
} as const);

export interface ExpeditionClockView {
  readonly period: ExpeditionPeriod;
  readonly elapsedMinutes: number;
  readonly remainingMinutes: number;
  readonly currentTime: string;
  readonly endTime: "18:00" | "06:00";
  readonly completed: boolean;
}

function clockLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function expeditionClock(
  period: ExpeditionPeriod,
  elapsedMinutes: number,
): ExpeditionClockView {
  if (
    !Number.isSafeInteger(elapsedMinutes) ||
    elapsedMinutes < 0 ||
    elapsedMinutes > EXPEDITION_DURATION_MINUTES
  ) {
    throw new RangeError("Expedition elapsed minutes must be in the closed 0–720 range");
  }

  const start = period === "DAY" ? 6 * 60 : 18 * 60;
  return {
    period,
    elapsedMinutes,
    remainingMinutes: EXPEDITION_DURATION_MINUTES - elapsedMinutes,
    currentTime: clockLabel((start + elapsedMinutes) % (24 * 60)),
    endTime: period === "DAY" ? "18:00" : "06:00",
    completed: elapsedMinutes === EXPEDITION_DURATION_MINUTES,
  };
}
