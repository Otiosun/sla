import { EXPEDITION_WEEKLY_LIMIT } from "./expedition-clock.js";

/**
 * Calendar policy only. The authoritative timezone must come from a
 * reviewed world configuration, never implicitly from the bot host.
 */
export function expeditionWeekKey(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("Expedition timestamp must be a valid instant");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (kind: "year" | "month" | "day"): number => {
    const found = parts.find((part) => part.type === kind)?.value;
    if (found === undefined) throw new RangeError("Missing expedition calendar component");
    return Number(found);
  };
  const localDay = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  const daysSinceMonday = (localDay.getUTCDay() + 6) % 7;
  localDay.setUTCDate(localDay.getUTCDate() - daysSinceMonday);
  return localDay.toISOString().slice(0, 10);
}

export type ExpeditionAdmissionState = "NONE" | "PREPARING" | "ACTIVE";

export interface ExpeditionWeeklyAdmission {
  readonly remaining: number;
  readonly canPrepare: boolean;
  readonly canConsumeFirstAction: boolean;
  readonly resumeExisting: boolean;
  readonly canContinue: boolean;
}

/**
 * Preparing does not spend a slot. Only a PREPARING expedition may
 * consume its first timed action, after rechecking the week's quota
 * atomically. An ACTIVE expedition can always continue, even after
 * a calendar reset or after the current week's slots are exhausted.
 */
export function expeditionWeeklyAdmission(
  consumedThisWeek: number,
  state: ExpeditionAdmissionState,
): ExpeditionWeeklyAdmission {
  if (
    !Number.isSafeInteger(consumedThisWeek) ||
    consumedThisWeek < 0 ||
    consumedThisWeek > EXPEDITION_WEEKLY_LIMIT
  ) {
    throw new RangeError("Weekly expedition count must be within the weekly limit");
  }

  const remaining = EXPEDITION_WEEKLY_LIMIT - consumedThisWeek;
  return {
    remaining,
    canPrepare: state === "NONE" && remaining > 0,
    canConsumeFirstAction: state === "PREPARING" && remaining > 0,
    resumeExisting: state !== "NONE",
    canContinue: state === "ACTIVE",
  };
}
