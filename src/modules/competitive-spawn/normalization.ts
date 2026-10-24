import type { CompetitiveSpawnTimeBucket } from "./contracts.js";

// Rendering follows the RPG world clock, independent of the server/CI timezone.
const worldHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  hourCycle: "h23",
});

export function normalizeCompetitiveSpawnGuess(value: string): string {
  return value
    .replace(/♀/gu, " f")
    .replace(/♂/gu, " m")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[.'’_]+/gu, "")
    .replace(/[-\s]+/gu, " ")
    .replace(/[^\p{L}\p{N} :]/gu, "")
    .trim();
}

export function competitiveSpawnTimeBucket(occurredAt: string): CompetitiveSpawnTimeBucket {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return "DAY";
  const hour = Number(worldHourFormatter.format(date));
  if (hour >= 5 && hour <= 10) return "MORNING";
  if (hour >= 11 && hour <= 16) return "DAY";
  if (hour >= 17 && hour <= 19) return "EVENING";
  return "NIGHT";
}
