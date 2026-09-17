import { describe, expect, it } from "vitest";
import {
  buildZhouliaDraftImportPlan,
  CAMPOS_DE_YUN,
  diffZhouliaContent,
  VILA_DOS_ARROZAIS,
  validateZhouliaContentBundle,
  ZHOULIA_TYPED_CONTENT_V1,
  zhouliaContentFingerprint,
} from "../../src/modules/world/zhoulia-content.js";

function species(area: typeof VILA_DOS_ARROZAIS, poolIdentity: string): string[] {
  const pool = area.encounterPools.find((entry) => entry.identity === poolIdentity);
  if (pool === undefined) throw new Error(`Missing pool ${poolIdentity}`);
  return pool.entries.map((entry) => entry.speciesKey.replace("pokemon.species.", ""));
}

describe("Zhoulia typed content V1", () => {
  it("models the first vertical from Vila dos Arrozais to Campos de Yun with stable identities", () => {
    expect(ZHOULIA_TYPED_CONTENT_V1.routes).toEqual([
      {
        identity: "zhoulia.route.vila-dos-arrozais.campos-de-yun",
        fromAreaIdentity: "zhoulia.area.vila-dos-arrozais",
        toAreaIdentity: "zhoulia.area.campos-de-yun",
        direction: "BIDIRECTIONAL",
      },
    ]);
    expect(() => validateZhouliaContentBundle(ZHOULIA_TYPED_CONTENT_V1)).not.toThrow();
    expect(
      buildZhouliaDraftImportPlan({ releaseStatus: "DRAFT" }).records.every(
        (record) => !/^[0-9a-f]{8}-/i.test(record.identity),
      ),
    ).toBe(true);
  });

  it("preserves the exact Vila encounter groups and distinct first/return arrival keys", () => {
    expect(species(VILA_DOS_ARROZAIS, "zhoulia.encounter-pool.vila-dos-arrozais.day.land")).toEqual(
      ["bellsprout", "hoppip", "sunkern", "lotad", "wooper", "poliwag"],
    );
    expect(species(VILA_DOS_ARROZAIS, "zhoulia.encounter-pool.vila-dos-arrozais.water")).toEqual([
      "magikarp",
      "goldeen",
      "psyduck",
      "marill",
      "tentacool",
    ]);
    expect(
      species(VILA_DOS_ARROZAIS, "zhoulia.encounter-pool.vila-dos-arrozais.village-rare"),
    ).toEqual(["meowth", "growlithe", "pikachu", "eevee"]);
    expect(
      species(VILA_DOS_ARROZAIS, "zhoulia.encounter-pool.vila-dos-arrozais.night.land"),
    ).toEqual(["hoothoot", "gastly", "wooper", "rattata", "meowth", "poochyena", "sentret"]);
    expect(VILA_DOS_ARROZAIS.narrativeKeys.firstArrival).not.toBe(
      VILA_DOS_ARROZAIS.narrativeKeys.returnArrival,
    );
  });

  it("preserves Yun pools, O Poço, and leaves the Grass Gym leader unnamed", () => {
    expect(species(CAMPOS_DE_YUN, "zhoulia.encounter-pool.campos-de-yun.day.land")).toEqual([
      "pidgey",
      "spearow",
      "sentret",
      "hoppip",
      "oddish",
      "bellsprout",
      "ponyta",
      "nidoran-f",
      "nidoran-m",
    ]);
    expect(species(CAMPOS_DE_YUN, "zhoulia.encounter-pool.campos-de-yun.rivers")).toEqual([
      "psyduck",
      "poliwag",
      "marill",
      "lotad",
      "magikarp",
    ]);
    expect(species(CAMPOS_DE_YUN, "zhoulia.encounter-pool.campos-de-yun.night.land")).toEqual([
      "hoothoot",
      "rattata",
      "poochyena",
      "gastly",
      "zubat",
      "shuppet",
      "marshtomp",
      "roselia",
      "nuzleaf",
      "quagsire",
      "gloom",
    ]);

    expect(CAMPOS_DE_YUN.sites).toContainEqual(
      expect.objectContaining({ displayName: "O Poço", kind: "SECRET_ARENA" }),
    );
    expect(CAMPOS_DE_YUN.npcRoles).toContainEqual(
      expect.objectContaining({ roleKey: "GRASS_GYM_LEADER", displayName: null }),
    );
  });

  it("has a deterministic fingerprint, a DRAFT-only import plan, and semantic diff", () => {
    const fingerprint = zhouliaContentFingerprint(ZHOULIA_TYPED_CONTENT_V1);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(zhouliaContentFingerprint(ZHOULIA_TYPED_CONTENT_V1)).toBe(fingerprint);

    expect(() => buildZhouliaDraftImportPlan({ releaseStatus: "VALIDATED" })).toThrow(/DRAFT/);
    expect(() => buildZhouliaDraftImportPlan({ releaseStatus: "PUBLISHED" })).toThrow(/DRAFT/);

    const changed = {
      ...ZHOULIA_TYPED_CONTENT_V1,
      areas: [
        {
          ...VILA_DOS_ARROZAIS,
          summary: `${VILA_DOS_ARROZAIS.summary} Ajuste editorial.`,
        },
        CAMPOS_DE_YUN,
      ],
    };
    expect(diffZhouliaContent(ZHOULIA_TYPED_CONTENT_V1, changed)).toEqual({
      added: [],
      removed: [],
      changed: ["zhoulia.area.vila-dos-arrozais"],
    });
  });

  it("keeps weather as an explicit future condition type without inventing a simulator", () => {
    const source = JSON.stringify(ZHOULIA_TYPED_CONTENT_V1);
    expect(source).not.toContain('"kind":"WEATHER"');
    expect(source).not.toContain("weatherEngine");
  });
});
