import { describe, expect, it } from "vitest";
import {
  buildZhouliaDirectedRoutes,
  buildZhouliaEncounterPoolDraftPlans,
  zhouliaEncounterConditions,
  zhouliaWorldAreaConfig,
} from "../../src/modules/world/zhoulia-catalog-adapter.js";
import {
  CAMPOS_DE_YUN,
  CIDADE_DO_AQUARIO,
  FLORESTA_DE_SEKIGLOOM_MIL_BAMBU,
  PORTO_DOS_CEUS,
  TEMPLO_DO_CEU_ANTIGO,
  VILA_DOS_ARROZAIS,
  ZHOULIA_TYPED_CONTENT_V1,
} from "../../src/modules/world/zhoulia-content.js";

describe("Zhoulia catalog adapter", () => {
  it("projects authored runtime kinds without inventing safe points", () => {
    expect(zhouliaWorldAreaConfig(VILA_DOS_ARROZAIS, 0)).toMatchObject({
      schemaVersion: 1,
      kind: "TOWN",
      safePoint: true,
      startingArea: true,
      relocationPriority: 0,
      facilities: ["POKEMON_CENTER", "POKEMART"],
    });
    expect(zhouliaWorldAreaConfig(CAMPOS_DE_YUN, 1)).toMatchObject({
      kind: "ROUTE",
      safePoint: false,
      startingArea: false,
      relocationPriority: 10,
    });
    expect(zhouliaWorldAreaConfig(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU, 2)).toMatchObject({
      kind: "ROUTE",
      safePoint: false,
      startingArea: false,
      relocationPriority: 20,
    });
    expect(zhouliaWorldAreaConfig(CIDADE_DO_AQUARIO, 3)).toMatchObject({
      kind: "CITY",
      safePoint: false,
      startingArea: false,
      relocationPriority: 30,
    });
    expect(zhouliaWorldAreaConfig(PORTO_DOS_CEUS, 4)).toMatchObject({
      kind: "OTHER",
      safePoint: false,
      startingArea: false,
      relocationPriority: 40,
    });
    expect(zhouliaWorldAreaConfig(TEMPLO_DO_CEU_ANTIGO, 5)).toMatchObject({
      kind: "OTHER",
      safePoint: false,
      startingArea: false,
      relocationPriority: 50,
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

  it("keeps only the authored Vila↔Yun route as two directed world connections", () => {
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

  it("keeps exactly the seven mechanically balanced Vila/Yun encounter pools", () => {
    const pools = buildZhouliaEncounterPoolDraftPlans(ZHOULIA_TYPED_CONTENT_V1);
    expect(pools).toHaveLength(7);
    expect(
      pools.every((pool) =>
        ["zhoulia.area.vila-dos-arrozais", "zhoulia.area.campos-de-yun"].includes(
          pool.areaIdentity,
        ),
      ),
    ).toBe(true);
  });

  it("keeps day and night land pools as distinct table slugs", () => {
    const pools = buildZhouliaEncounterPoolDraftPlans(ZHOULIA_TYPED_CONTENT_V1);
    expect(
      pools
        .filter((pool) => pool.areaIdentity === "zhoulia.area.vila-dos-arrozais")
        .map((pool) => pool.tableSlug),
    ).toEqual(["day-land", "water", "village-rare", "night-land"]);
    expect(
      pools
        .filter((pool) => pool.areaIdentity === "zhoulia.area.campos-de-yun")
        .map((pool) => pool.tableSlug),
    ).toEqual(["day-land", "rivers", "night-land"]);
    expect(new Set(pools.map((pool) => `${pool.areaIdentity}:${pool.tableSlug}`)).size).toBe(7);
  });
});
