import { describe, expect, it } from "vitest";
import {
  ConnectionAccessRuleSchema,
  WorldAreaConfigSchema,
} from "../../src/modules/catalog/world-contracts.js";

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

  it("accepts content-driven fishing configuration on an area", () => {
    const parsed = WorldAreaConfigSchema.parse({
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
          RARE: "fishing-rare",
          EXTREMELY_RARE: "fishing-extremely-rare",
        },
      },
    });

    expect(parsed.fishing).toEqual({
      pointName: "Rio dos Arrozais",
      encounterTables: {
        COMMON: "fishing-common",
        UNCOMMON: "fishing-uncommon",
        RARE: "fishing-rare",
        EXTREMELY_RARE: "fishing-extremely-rare",
      },
    });
  });

  it("allows rare fishing pools to remain unconfigured until administration defines them", () => {
    const parsed = WorldAreaConfigSchema.parse({
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

    expect(parsed.fishing?.encounterTables.RARE).toBeUndefined();
    expect(parsed.fishing?.encounterTables.EXTREMELY_RARE).toBeUndefined();
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
