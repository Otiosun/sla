import { describe, expect, it } from "vitest";
import {
  ConnectionAccessRuleSchema,
  WorldAreaConfigSchema,
} from "../../src/modules/catalog/world-contracts.js";

const FISHING_CONFIG = {
  pointName: "Rio dos Arrozais",
  encounterTables: {
    COMMON: "fishing-common",
    UNCOMMON: "fishing-uncommon",
    RARE: "fishing-rare",
    EXTREMELY_RARE: "fishing-extremely-rare",
  },
} as const;

describe("versioned world content contracts", () => {
  it("accepts canonical area and connection policies", () => {
    expect(
      WorldAreaConfigSchema.parse({
        schemaVersion: 1,
        kind: "TOWN",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: true,
      relocationPriority: 0,
      facilities: [],
    });

    expect(
      ConnectionAccessRuleSchema.parse({
        schemaVersion: 1,
        requiredUnlockKeys: ["world.kanto.viridian-access"],
      }),
    ).toEqual({
      schemaVersion: 1,
      requiredUnlockKeys: ["world.kanto.viridian-access"],
    });
  });

  it("defines facilities as content-driven area authority and defaults them closed", () => {
    const withoutFacilities = WorldAreaConfigSchema.parse({
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: false,
      relocationPriority: 10,
    });
    expect((withoutFacilities as { facilities?: unknown }).facilities).toEqual([]);

    const withFacilities = WorldAreaConfigSchema.safeParse({
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: false,
      relocationPriority: 10,
      facilities: ["POKEMART", "POKEMON_CENTER"],
    });
    expect(withFacilities.success).toBe(true);
    if (!withFacilities.success) return;
    expect((withFacilities.data as { facilities?: unknown }).facilities).toEqual([
      "POKEMART",
      "POKEMON_CENTER",
    ]);
  });

  it("accepts content-driven fishing configuration on an area", () => {
    const parsed = WorldAreaConfigSchema.safeParse({
      schemaVersion: 1,
      kind: "ROUTE",
      safePoint: true,
      startingArea: false,
      relocationPriority: 20,
      fishing: FISHING_CONFIG,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ fishing: FISHING_CONFIG });
  });

  it("allows rare fishing pools to remain unconfigured until administration defines them", () => {
    const parsed = WorldAreaConfigSchema.safeParse({
      schemaVersion: 1,
      kind: "ROUTE",
      safePoint: true,
      startingArea: false,
      relocationPriority: 20,
      fishing: {
        pointName: "Rio dos Arrozais",
        encounterTables: {
          COMMON: "fishing-common",
          UNCOMMON: "fishing-uncommon",
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      fishing: {
        pointName: "Rio dos Arrozais",
        encounterTables: {
          COMMON: "fishing-common",
          UNCOMMON: "fishing-uncommon",
        },
      },
    });
  });

  it("rejects unknown schema versions, executable extras and malformed unlock keys", () => {
    expect(
      WorldAreaConfigSchema.safeParse({
        schemaVersion: 2,
        kind: "TOWN",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
      }).success,
    ).toBe(false);

    expect(
      WorldAreaConfigSchema.safeParse({
        schemaVersion: 1,
        kind: "TOWN",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
        javascript: "process.exit()",
      }).success,
    ).toBe(false);

    expect(
      ConnectionAccessRuleSchema.safeParse({
        schemaVersion: 1,
        requiredUnlockKeys: ["INVALID KEY"],
      }).success,
    ).toBe(false);
  });
});
