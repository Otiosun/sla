import { describe, expect, it } from "vitest";
import {
  COMPETITIVE_SPAWN_BACKGROUND_GROUPS,
  COMPETITIVE_SPAWN_BACKGROUND_URLS,
  competitiveSpawnBackgroundContextForTypes,
  competitiveSpawnBackgroundUrlFor,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn type-aware background context", () => {
  it("maps canonical Pokemon type slugs to contextual background groups", () => {
    expect(competitiveSpawnBackgroundContextForTypes("water", null)).toBe("WATER");
    expect(competitiveSpawnBackgroundContextForTypes("water", "flying")).toBe("WATER");
    expect(competitiveSpawnBackgroundContextForTypes("ice", "flying")).toBe("SNOW");
    expect(competitiveSpawnBackgroundContextForTypes("dragon", "flying")).toBe("SKY");
    expect(competitiveSpawnBackgroundContextForTypes("rock", "ground")).toBe("RUGGED");
    expect(competitiveSpawnBackgroundContextForTypes("fire", null)).toBe("RUGGED");
    expect(competitiveSpawnBackgroundContextForTypes("electric", null)).toBe("NEUTRAL");
    expect(competitiveSpawnBackgroundContextForTypes(undefined, null)).toBe("NEUTRAL");
  });

  it("never selects a background outside the requested context bucket", () => {
    const contexts = ["NEUTRAL", "RUGGED", "SNOW", "WATER", "SKY"] as const;

    for (const context of contexts) {
      const ids = COMPETITIVE_SPAWN_BACKGROUND_GROUPS[context];
      for (let roll = 0; roll < ids.length; roll += 1) {
        const id = ids[roll];
        if (id === undefined) throw new Error("Context bucket cannot contain holes");
        const url = competitiveSpawnBackgroundUrlFor({
          context,
          rng: { randomInt: () => roll },
        });
        expect(url).toBe(COMPETITIVE_SPAWN_BACKGROUND_URLS[id - 1]);
      }
    }
  });
});
