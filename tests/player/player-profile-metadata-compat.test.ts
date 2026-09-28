import { describe, expect, it } from "vitest";
import {
  PersistedPlayerProfileMetadataSchema,
  PlayerProfileMetadataSchema,
  ProfileInputSchema,
} from "../../src/modules/player/contracts.js";

describe("player profile metadata compatibility", () => {
  it("accepts subsystem-owned keys when reading persisted metadata", () => {
    const stored = {
      profession: "EXPLORADOR",
      hubCustomization: {
        title: "O Sobrevivente",
        accent: "violet",
      },
      endgame: true,
      leaderSeed: "V36C",
      leaderIndex: 2,
    };

    const parsed = PersistedPlayerProfileMetadataSchema.parse(stored);

    expect(parsed).toEqual(stored);
    expect(parsed.profession).toBe("EXPLORADOR");
  });

  it("still validates the profession inside persisted metadata", () => {
    expect(
      PersistedPlayerProfileMetadataSchema.safeParse({
        profession: "ASTRONAUTA",
        hubCustomization: { accent: "gold" },
      }).success,
    ).toBe(false);
  });

  it("keeps new profile input strict instead of accepting arbitrary metadata", () => {
    expect(
      PlayerProfileMetadataSchema.safeParse({
        profession: "CRIADOR",
        hubCustomization: { accent: "gold" },
      }).success,
    ).toBe(false);

    expect(
      ProfileInputSchema.safeParse({
        trainerName: "Liora",
        metadata: {
          profession: "CRIADOR",
          endgame: true,
        },
      }).success,
    ).toBe(false);
  });
});
