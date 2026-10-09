import { describe, expect, it } from "vitest";
import {
  competitiveSpawnTimeBucket,
  normalizeCompetitiveSpawnGuess,
} from "../../src/modules/competitive-spawn/normalization.js";

describe("competitive spawn normalization", () => {
  it("normalizes accents, punctuation, hyphens and case without fuzzy guessing", () => {
    expect(normalizeCompetitiveSpawnGuess("  Farfetch'd!! ")).toBe("farfetchd");
    expect(normalizeCompetitiveSpawnGuess("Mr. Mime")).toBe("mr mime");
    expect(normalizeCompetitiveSpawnGuess("Porygon-Z")).toBe("porygon z");
    expect(normalizeCompetitiveSpawnGuess("Nidoran♀")).toBe("nidoran f");
    expect(normalizeCompetitiveSpawnGuess("Nidoran♂")).toBe("nidoran m");
  });

  it("maps local clock time into the four visual buckets", () => {
    expect(competitiveSpawnTimeBucket("2026-10-08T06:00:00-03:00")).toBe("MORNING");
    expect(competitiveSpawnTimeBucket("2026-10-08T13:00:00-03:00")).toBe("DAY");
    expect(competitiveSpawnTimeBucket("2026-10-08T18:00:00-03:00")).toBe("EVENING");
    expect(competitiveSpawnTimeBucket("2026-10-08T23:00:00-03:00")).toBe("NIGHT");
  });
});
