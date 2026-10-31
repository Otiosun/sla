/**
 * Fishing quota calendar. This is a pure mapping from an instant to the
 * authoritative world calendar day, not the bot host or PostgreSQL session.
 * The timezone must be approved and supplied explicitly by the release.
 */
export function fishingDayKey(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("Fishing instant must be a valid timestamp");
  }
  if (timeZone.trim() === "") {
    throw new RangeError("Fishing world timezone must be configured");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const getPart = (type: "year" | "month" | "day"): string => {
    const part = parts.find((value) => value.type === type)?.value;
    if (part === undefined || !/^\\d{1,4}$/.test(part)) {
      throw new RangeError("Invalid fishing calendar day component");
    }
    return part.padStart(type === "year" ? 4 : 2, "0");
  };
  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
}
