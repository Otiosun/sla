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

  it("selects backgrounds by habitat, not just elemental type", () => {
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("pidgey", "normal", "flying", 3))
      .toBe("NEUTRAL");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("sandshrew", "ground", null, 6))
      .toBe("RUGGED");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("staryu", "water", null, 7))
      .toBe("WATER");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("eevee", "normal", null, 8))
      .toBe("NEUTRAL");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("wingull", "water", "flying", 9))
      .toBe("SKY");
    expect(competitiveSpawnBackgroundContextForSpeciesAndTypes("spheal", "ice", "water", 7))
      .toBe("SNOW");
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
