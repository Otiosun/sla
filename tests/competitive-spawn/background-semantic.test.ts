import { describe, expect, it } from "vitest";
import {
  COMPETITIVE_SPAWN_BACKGROUND_GROUPS,
  COMPETITIVE_SPAWN_BACKGROUND_URLS,
  competitiveSpawnBackgroundContextForSpeciesAndTypes,
  competitiveSpawnBackgroundContextForTypes,
  competitiveSpawnBackgroundUrlFor,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn semantic background routing", () => {
  it("re-buckets BG11 into RUGGED and isolates BG21 into COSMIC", () => {
    expect(COMPETITIVE_SPAWN_BACKGROUND_GROUPS.NEUTRAL).toEqual([1, 3, 4]);
    expect(COMPETITIVE_SPAWN_BACKGROUND_GROUPS.RUGGED).toEqual([2, 5, 6, 8, 11, 18, 20]);
    expect(COMPETITIVE_SPAWN_BACKGROUND_GROUPS.SKY).toEqual([9, 12, 16]);
    expect(COMPETITIVE_SPAWN_BACKGROUND_GROUPS.COSMIC).toEqual([21]);

    const ids = Object.values(COMPETITIVE_SPAWN_BACKGROUND_GROUPS).flat();
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect([...ids].sort((a, b) => a - b)).toEqual([...Array(23)].map((_, i) => i + 1));
  });

  it("keeps generic type mapping deterministic", () => {
    expect(competitiveSpawnBackgroundContextForTypes("water", null)).toBe("WATER");
    expect(competitiveSpawnBackgroundContextForTypes("ice", "flying")).toBe("SNOW");
    expect(competitiveSpawnBackgroundContextForTypes("dragon", "flying")).toBe("SKY");
    expect(competitiveSpawnBackgroundContextForTypes("rock", "ground")).toBe("RUGGED");
    expect(competitiveSpawnBackgroundContextForTypes("electric", null)).toBe("NEUTRAL");
  });

  it("reserves COSMIC only for explicit special species", () => {
    expect(
      competitiveSpawnBackgroundContextForSpeciesAndTypes("rayquaza", "dragon", "flying"),
    ).toBe("COSMIC");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("deoxys", "psychic", null)).toBe(
      "COSMIC",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("pidgey", "normal", "flying")).toBe(
      "SKY",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("pikachu", "electric", null)).toBe(
      "NEUTRAL",
    );
  });

  it("never selects a background outside the requested bucket", () => {
    const contexts = ["NEUTRAL", "RUGGED", "SNOW", "WATER", "SKY", "COSMIC"] as const;
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
  it("routes ambiguous Water/Flying species explicitly", () => {
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("wingull", "water", "flying")).toBe(
      "SKY",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("pelipper", "water", "flying")).toBe(
      "SKY",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("gyarados", "water", "flying")).toBe(
      "WATER",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("mantine", "water", "flying")).toBe(
      "WATER",
    );
  });
});
