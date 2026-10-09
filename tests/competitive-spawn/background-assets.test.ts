import { describe, expect, it } from "vitest";
import {
  COMPETITIVE_SPAWN_BACKGROUND_REVISION,
  COMPETITIVE_SPAWN_BACKGROUND_URLS,
  competitiveSpawnArtworkUrl,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn background/artwork assets", () => {
  it("pins exactly the 23 PokeTwo-AI backgrounds", () => {
    expect(COMPETITIVE_SPAWN_BACKGROUND_REVISION).toBe("5efaff824d4255e347da71f4a175239a3f8c3874");
    expect(COMPETITIVE_SPAWN_BACKGROUND_URLS).toHaveLength(23);
    expect(new Set(COMPETITIVE_SPAWN_BACKGROUND_URLS).size).toBe(23);

    for (let id = 1; id <= 23; id += 1) {
      expect(COMPETITIVE_SPAWN_BACKGROUND_URLS[id - 1]).toBe(
        `https://raw.githubusercontent.com/LightningDev1/PokeTwo-AI/${COMPETITIVE_SPAWN_BACKGROUND_REVISION}/backgrounds/${id}.png`,
      );
    }
  });

  it("uses only Official Artwork and the exact shiny Official Artwork path", () => {
    expect(competitiveSpawnArtworkUrl(25, false)).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png",
    );
    expect(competitiveSpawnArtworkUrl(25, true)).toBe(
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/25.png",
    );
  });

  it("rejects invalid National Dex ids before constructing remote artwork URLs", () => {
    expect(() => competitiveSpawnArtworkUrl(0, false)).toThrow(RangeError);
    expect(() => competitiveSpawnArtworkUrl(-1, true)).toThrow(RangeError);
    expect(() => competitiveSpawnArtworkUrl(25.5, false)).toThrow(RangeError);
  });
});
