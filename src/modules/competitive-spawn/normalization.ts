import type { CompetitiveSpawnTimeBucket } from "./contracts.js";

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
  const hour = date.getHours();
  if (hour >= 5 && hour <= 10) return "MORNING";
  if (hour >= 11 && hour <= 16) return "DAY";
  if (hour >= 17 && hour <= 19) return "EVENING";
  return "NIGHT";
}
