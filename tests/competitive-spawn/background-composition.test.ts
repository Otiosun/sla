import { describe, expect, it } from "vitest";
import {
  COMPETITIVE_SPAWN_BACKGROUND_GROUPS,
  COMPETITIVE_SPAWN_BACKGROUND_URLS,
  competitiveSpawnBackgroundUrlFor,
  competitiveSpawnCenterX,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn background composition", () => {
  it("partitions the 23 pinned backgrounds into explicit context groups", () => {
    const ids = Object.values(COMPETITIVE_SPAWN_BACKGROUND_GROUPS).flat();
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect([...ids].sort((a, b) => a - b)).toEqual([...Array(23)].map((_, i) => i + 1));
  });

  it("uses only neutral backgrounds by default", () => {
    const url = competitiveSpawnBackgroundUrlFor({
      rng: { randomInt: () => 0 },
    });
    expect(url).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[0]);

    const lastNeutralUrl = competitiveSpawnBackgroundUrlFor({
      rng: { randomInt: (maxExclusive: number) => maxExclusive - 1 },
    });
    const lastNeutralId =
      COMPETITIVE_SPAWN_BACKGROUND_GROUPS.NEUTRAL[
        COMPETITIVE_SPAWN_BACKGROUND_GROUPS.NEUTRAL.length - 1
      ];
    if (lastNeutralId === undefined) {
      throw new Error("Competitive spawn neutral background group cannot be empty");
    }
    expect(lastNeutralUrl).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[lastNeutralId - 1]);
  });

  it("selects only backgrounds from the requested context bucket", () => {
    const waterFirst = competitiveSpawnBackgroundUrlFor({
      context: "WATER",
      rng: { randomInt: () => 0 },
    });
    expect(waterFirst).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[13]);

    const waterLast = competitiveSpawnBackgroundUrlFor({
      context: "WATER",
      rng: { randomInt: (maxExclusive: number) => maxExclusive - 1 },
    });
    expect(waterLast).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[18]);

    const skyFirst = competitiveSpawnBackgroundUrlFor({
      context: "SKY",
      rng: { randomInt: () => 0 },
    });
    expect(skyFirst).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[8]);
  });

  it("keeps centerX near the real center instead of drifting right", () => {
    const min = competitiveSpawnCenterX({ rng: { randomInt: () => 0 } });
    const max = competitiveSpawnCenterX({
      rng: { randomInt: (maxExclusive: number) => maxExclusive - 1 },
    });
    expect(min).toBeGreaterThanOrEqual(382);
    expect(max).toBeLessThanOrEqual(418);
    expect(Math.abs(400 - min)).toBeLessThanOrEqual(18);
    expect(Math.abs(400 - max)).toBeLessThanOrEqual(18);
  });
});
