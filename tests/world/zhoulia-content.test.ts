import { describe, expect, it } from "vitest";
import {
  buildZhouliaDraftImportPlan,
  CAMPOS_DE_YUN,
  CIDADE_DO_AQUARIO,
  diffZhouliaContent,
  FLORESTA_DE_SEKIGLOOM_MIL_BAMBU,
  PORTO_DOS_CEUS,
  TEMPLO_DO_CEU_ANTIGO,
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
  it("keeps the canonical Vila↔Yun route and adds the four remaining authored areas without invented routes", () => {
    expect(ZHOULIA_TYPED_CONTENT_V1.areas.map((area) => area.identity)).toEqual([
      "zhoulia.area.vila-dos-arrozais",
      "zhoulia.area.campos-de-yun",
      "zhoulia.area.floresta-de-sekigloom-mil-bambu",
      "zhoulia.area.cidade-do-aquario",
      "zhoulia.area.porto-dos-ceus",
      "zhoulia.area.templo-do-ceu-antigo",
    ]);
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

  it("preserves Sekigloom/Mil Bambu/Sekizor naming without fabricating encounters", () => {
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.displayName).toBe("Floresta de Sekigloom / Mil Bambu");
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.runtimeKind).toBe("ROUTE");
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.sites).toContainEqual(
      expect.objectContaining({ displayName: "Santuário Sekizor", kind: "SHRINE" }),
    );
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.encounterPools).toEqual([]);
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.editorialNotes.join(" ")).toMatch(
      /Sekigloom.*Sekizor.*Mil Bambu/i,
    );
    expect(FLORESTA_DE_SEKIGLOOM_MIL_BAMBU.editorialNotes.join(" ")).toMatch(/noite|noturn/i);
  });

  it("preserves Cidade do Aquário, Porto dos Céus and Templo do Céu Antigo without invented NPCs or pools", () => {
    expect(CIDADE_DO_AQUARIO.runtimeKind).toBe("CITY");
    expect(CIDADE_DO_AQUARIO.sites).toContainEqual(
      expect.objectContaining({ displayName: "Ginásio das Marés", kind: "GYM" }),
    );
    expect(CIDADE_DO_AQUARIO.npcRoles).toEqual([]);
    expect(CIDADE_DO_AQUARIO.encounterPools).toEqual([]);
    expect(CIDADE_DO_AQUARIO.editorialNotes.join(" ")).toMatch(/urbano|água|submers|raro/i);

    expect(PORTO_DOS_CEUS.runtimeKind).toBe("OTHER");
    expect(PORTO_DOS_CEUS.sites.some((site) => site.kind === "GYM")).toBe(false);
    expect(PORTO_DOS_CEUS.npcRoles).toEqual([]);
    expect(PORTO_DOS_CEUS.encounterPools).toEqual([]);

    expect(TEMPLO_DO_CEU_ANTIGO.runtimeKind).toBe("OTHER");
    expect(TEMPLO_DO_CEU_ANTIGO.encounterPools).toEqual([]);
    expect(TEMPLO_DO_CEU_ANTIGO.editorialNotes.join(" ")).toContain("Dragonite");
    expect(TEMPLO_DO_CEU_ANTIGO.editorialNotes.join(" ")).toContain("Salamence");
    expect(TEMPLO_DO_CEU_ANTIGO.editorialNotes.join(" ")).toContain("Flygon");
    expect(TEMPLO_DO_CEU_ANTIGO.editorialNotes.join(" ")).toContain("Altaria");
    expect(TEMPLO_DO_CEU_ANTIGO.editorialNotes.join(" ")).toMatch(
      /semelhante a Rayquaza.*mistério/i,
    );
  });

  it("does not invent numeric clock ranges for authored DAY/NIGHT references", () => {
    const source = JSON.stringify(ZHOULIA_TYPED_CONTENT_V1);
    expect(source).not.toMatch(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/);
  });

  it("has a deterministic fingerprint, a DRAFT-only import plan, and semantic diff", () => {
    const fingerprint = zhouliaContentFingerprint(ZHOULIA_TYPED_CONTENT_V1);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(zhouliaContentFingerprint(ZHOULIA_TYPED_CONTENT_V1)).toBe(fingerprint);

    expect(() => buildZhouliaDraftImportPlan({ releaseStatus: "VALIDATED" })).toThrow(/DRAFT/);
    expect(() => buildZhouliaDraftImportPlan({ releaseStatus: "PUBLISHED" })).toThrow(/DRAFT/);

    const changed = {
      ...ZHOULIA_TYPED_CONTENT_V1,
      areas: ZHOULIA_TYPED_CONTENT_V1.areas.map((area, index) =>
        index === 0
          ? {
              ...area,
              summary: `${area.summary} Ajuste editorial.`,
            }
          : area,
      ),
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
