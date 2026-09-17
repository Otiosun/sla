import { describe, expect, it } from "vitest";
import {
  buildZhouliaDirectedRoutes,
  buildZhouliaEncounterPoolDraftPlans,
  zhouliaEncounterConditions,
  zhouliaWorldAreaConfig,
} from "../../src/modules/world/zhoulia-catalog-adapter.js";
import {
  CAMPOS_DE_YUN,
  VILA_DOS_ARROZAIS,
  ZHOULIA_TYPED_CONTENT_V1,
} from "../../src/modules/world/zhoulia-content.js";

describe("Zhoulia catalog adapter", () => {
  it("projects Vila into runtime-safe area config with presentation metadata", () => {
    expect(zhouliaWorldAreaConfig(VILA_DOS_ARROZAIS, 0)).toMatchObject({
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: true,
      relocationPriority: 0,
      facilities: ["POKEMON_CENTER", "POKEMART"],
      presentation: {
        summary: VILA_DOS_ARROZAIS.summary,
        narrativeKeys: {
          firstArrival: "zhoulia.vila-dos-arrozais.arrival.first",
          returnArrival: "zhoulia.vila-dos-arrozais.arrival.return",
        },
      },
    });
    expect(zhouliaWorldAreaConfig(CAMPOS_DE_YUN, 1)).toMatchObject({
      schemaVersion: 1,
      kind: "ROUTE",
      safePoint: false,
      startingArea: false,
      relocationPriority: 10,
    });
  });

  it("translates editorial conditions into explicit catalog conditions", () => {
    const pool = VILA_DOS_ARROZAIS.encounterPools.find((entry) =>
      entry.identity.endsWith(".night.land"),
    );
    expect(pool).toBeDefined();
    if (pool === undefined) return;
    expect(zhouliaEncounterConditions(pool)).toEqual({
      schemaVersion: 1,
      requiredUnlockKeys: [],
      blockedUnlockKeys: [],
      timeOfDay: "NIGHT",
      surface: "LAND",
    });
  });

  it("expands one bidirectional route into two directed world connections", () => {
    expect(buildZhouliaDirectedRoutes()).toEqual([
      expect.objectContaining({
        fromAreaIdentity: "zhoulia.area.vila-dos-arrozais",
        toAreaIdentity: "zhoulia.area.campos-de-yun",
        connectionKey: "vila-dos-arrozais-to-campos-de-yun",
      }),
      expect.objectContaining({
        fromAreaIdentity: "zhoulia.area.campos-de-yun",
        toAreaIdentity: "zhoulia.area.vila-dos-arrozais",
        connectionKey: "campos-de-yun-to-vila-dos-arrozais",
      }),
    ]);
  });

  it("keeps encounter balance explicitly unresolved instead of inventing weights or levels", () => {
    const pools = buildZhouliaEncounterPoolDraftPlans(ZHOULIA_TYPED_CONTENT_V1);
    expect(pools).toHaveLength(7);
    expect(pools.every((pool) => pool.balanceStatus === "PENDING_LEVELS_AND_WEIGHTS")).toBe(true);
    expect(pools[0]).not.toHaveProperty("weight");
    expect(pools[0]).not.toHaveProperty("minLevel");
    expect(pools[0]).not.toHaveProperty("maxLevel");
  });
});
