import { describe, expect, it } from "vitest";
import {
  COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT,
  competitiveSpawnBackgroundContextForSpeciesAndTypes,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn ecology policy", () => {
  it("prioritizes the broad competitive pool while preserving local flavor", () => {
    expect(COMPETITIVE_SPAWN_LOCAL_BIAS_PERCENT).toBe(25);
  });

  it("uses habitat overrides before broad type heuristics", () => {
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("zubat", "poison", "flying")).toBe(
      "RUGGED",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("crobat", "poison", "flying")).toBe(
      "RUGGED",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("dratini", "dragon", null)).toBe(
      "WATER",
    );
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("wingull", "water", "flying")).toBe(
      "SKY",
    );
  });

  it("keeps strong elemental and special contexts intact", () => {
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("piloswine", "ice", "ground")).toBe(
      "SNOW",
    );
    expect(
      competitiveSpawnBackgroundContextForSpeciesAndTypes("rayquaza", "dragon", "flying"),
    ).toBe("COSMIC");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("shroomish", "grass", null)).toBe(
      "NEUTRAL",
    );
  });
});
