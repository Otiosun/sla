import { describe, expect, it } from "vitest";
import {
  competitiveSpawnTimeBucket,
  competitiveSpawnTrigger,
  normalizeCompetitiveSpawnGuess,
} from "../../src/modules/competitive-spawn/normalization.js";

describe("competitive spawn normalization", () => {
  it("normalizes accents, punctuation, hyphens and case without fuzzy guessing", () => {
    expect(normalizeCompetitiveSpawnGuess("  Farfetch'd!! ")).toBe("farfetchd");
    expect(normalizeCompetitiveSpawnGuess("Mr. Mime")).toBe("mr mime");
    expect(normalizeCompetitiveSpawnGuess("Porygon-Z")).toBe("porygon z");
  });

  it("uses a deterministic activity trigger", () => {
    const message = {
      provider: "baileys",
      chatRef: "game@g.us",
      externalMessageId: "wamid-fixed",
      text: "narracao de teste",
    };
    expect(competitiveSpawnTrigger(message, 18)).toBe(competitiveSpawnTrigger(message, 18));
  });

  it("maps local clock time into the four visual buckets", () => {
    expect(competitiveSpawnTimeBucket("2026-10-08T06:00:00-03:00")).toBe("MORNING");
    expect(competitiveSpawnTimeBucket("2026-10-08T13:00:00-03:00")).toBe("DAY");
    expect(competitiveSpawnTimeBucket("2026-10-08T18:00:00-03:00")).toBe("EVENING");
    expect(competitiveSpawnTimeBucket("2026-10-08T23:00:00-03:00")).toBe("NIGHT");
  });
});
