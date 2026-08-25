import { describe, expect, it } from "vitest";
import { diffCatalogSnapshots, formatReleaseDiff } from "../../src/modules/catalog/diff.js";
import { fingerprintCatalog, fingerprintRuleset } from "../../src/modules/catalog/fingerprint.js";
import {
  type CatalogSnapshotWithEffects,
  validateCatalogSnapshot,
} from "../../src/modules/catalog/validation.js";

const RULESET_CONFIG = {
  schemaVersion: 1,
  battle: {
    statModel: "SIX_STATS",
    physicalSpecialByMove: true,
    ivEnabled: true,
    evEnabled: false,
    natureEnabled: true,
    maxMoves: 4,
    ppEnabled: true,
    criticalMultiplierBasisPoints: 15_000,
    accuracyEvasionEnabled: true,
  },
  capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 9_500 },
  defeat: { automaticMoneyLoss: false },
  narrative: { authority: "N0_FLAVOR_ONLY" },
} as const;

function validSnapshot(releaseId = "release-1"): CatalogSnapshotWithEffects {
  return {
    release: {
      id: releaseId,
      releaseNo: releaseId === "release-1" ? "1" : "2",
      status: "PUBLISHED",
      parentReleaseId: null,
      defaultRulesetId: "ruleset-1",
    },
    ruleset: {
      id: "ruleset-1",
      status: "PUBLISHED",
      config: RULESET_CONFIG,
      typeMatchups: [
        {
          attackingTypeId: "type-normal",
          defendingTypeId: "type-normal",
          multiplierBasisPoints: 10_000,
        },
      ],
    },
    types: [{ typeId: "type-normal", displayName: "Normal", active: true }],
    species: [{ speciesId: "species-1", displayName: "Testmon", active: true }],
    forms: [
      {
        formId: "form-1",
        speciesId: "species-1",
        type1Id: "type-normal",
        type2Id: null,
        active: true,
      },
    ],
    moves: [
      {
        moveId: "move-1",
        typeId: "type-normal",
        category: "PHYSICAL",
        power: 40,
        accuracy: 100,
        priority: 0,
        maxPp: 35,
        effectKey: null,
        effectConfig: {},
        active: true,
      },
    ],
    abilities: [
      {
        abilityId: "ability-1",
        effectKey: "run-away",
        effectConfig: {},
        active: true,
      },
    ],
    items: [
      {
        itemId: "item-1",
        itemKind: "MEDICINE",
        effectKey: "heal-hp",
        effectConfig: { amount: 20 },
        active: true,
      },
    ],
    natures: [
      {
        natureId: "nature-1",
        increasedStat: null,
        decreasedStat: null,
        active: true,
      },
    ],
    effects: [],
    regions: [{ regionId: "region-1", active: true }],
    areas: [{ areaId: "area-1", regionId: "region-1", active: true }],
    connections: [],
    formAbilities: [{ formId: "form-1", abilityId: "ability-1", active: true }],
    learnsets: [
      {
        formId: "form-1",
        moveId: "move-1",
        learnMethod: "START",
        learnLevel: null,
        active: true,
      },
    ],
    evolutions: [],
    starterOptions: [
      {
        regionId: "region-1",
        formId: "form-1",
        starterLevel: 5,
        sortOrder: 1,
        active: true,
      },
    ],
    encounterTables: [
      {
        encounterTableId: "encounter-1",
        areaId: "area-1",
        active: true,
        entries: [
          {
            formId: "form-1",
            weight: "100",
            minLevel: 2,
            maxLevel: 4,
            active: true,
          },
        ],
      },
    ],
    parentCoverage: null,
  };
}

describe("catalog contracts", () => {
  it("accepts a complete minimal release snapshot", () => {
    expect(validateCatalogSnapshot(validSnapshot())).toEqual({ valid: true, issues: [] });
  });

  it("rejects unknown executable-like effect primitives", () => {
    const snapshot = validSnapshot();
    const firstMove = snapshot.moves[0];
    expect(firstMove).toBeDefined();
    if (firstMove === undefined) return;

    const invalid: CatalogSnapshotWithEffects = {
      ...snapshot,
      moves: [
        {
          ...firstMove,
          effectKey: "javascript",
          effectConfig: { source: "process.exit()" },
        },
      ],
    };

    const report = validateCatalogSnapshot(invalid);
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.code === "EFFECT_CONFIG_INVALID")).toBe(true);
  });

  it("rejects an incomplete type chart", () => {
    const snapshot = validSnapshot();
    const invalid: CatalogSnapshotWithEffects = {
      ...snapshot,
      types: [...snapshot.types, { typeId: "type-fire", displayName: "Fire", active: true }],
    };

    const report = validateCatalogSnapshot(invalid);
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.code === "TYPE_CHART_INCOMPLETE")).toBe(true);
  });

  it("fingerprints rulesets and catalogs independently of collection order", () => {
    const snapshot = validSnapshot();
    const extraMatchup = {
      attackingTypeId: "type-normal",
      defendingTypeId: "type-ghost",
      multiplierBasisPoints: 0,
    };
    const leftRuleset = {
      ...snapshot.ruleset,
      typeMatchups: [...snapshot.ruleset.typeMatchups, extraMatchup],
    };
    const rightRuleset = {
      ...snapshot.ruleset,
      typeMatchups: [extraMatchup, ...snapshot.ruleset.typeMatchups],
    };

    expect(fingerprintRuleset(leftRuleset)).toBe(fingerprintRuleset(rightRuleset));

    const reordered: CatalogSnapshotWithEffects = {
      ...snapshot,
      learnsets: [...snapshot.learnsets].reverse(),
      encounterTables: snapshot.encounterTables.map((table) => ({
        ...table,
        entries: [...table.entries].reverse(),
      })),
    };
    expect(fingerprintCatalog(snapshot)).toBe(fingerprintCatalog(reordered));
  });

  it("treats starter options as fingerprinted, validated and diffable content", () => {
    const before = validSnapshot("release-1");
    const starter = before.starterOptions[0];
    expect(starter).toBeDefined();
    if (starter === undefined) return;

    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot("release-2"),
      starterOptions: [{ ...starter, starterLevel: 10 }],
    };
    expect(fingerprintCatalog(after)).not.toBe(fingerprintCatalog(before));
    expect(
      diffCatalogSnapshots(before, after).sections.find(
        (section) => section.category === "starterOptions",
      ),
    ).toEqual({ category: "starterOptions", added: 0, removed: 0, changed: 1 });

    const invalid: CatalogSnapshotWithEffects = {
      ...before,
      starterOptions: [{ ...starter, formId: "missing-form", starterLevel: 0 }],
    };
    const report = validateCatalogSnapshot(invalid);
    expect(report.valid).toBe(false);
    expect(report.issues.some((entry) => entry.code === "STARTER_OPTION_REFERENCE_MISSING")).toBe(
      true,
    );
    expect(report.issues.some((entry) => entry.code === "STARTER_OPTION_RANGE_INVALID")).toBe(true);
  });

  it("produces a readable release diff without changing historical snapshots", () => {
    const before = validSnapshot("release-1");
    const beforeMove = before.moves[0];
    expect(beforeMove).toBeDefined();
    if (beforeMove === undefined) return;

    const after: CatalogSnapshotWithEffects = {
      ...validSnapshot("release-2"),
      release: {
        ...validSnapshot("release-2").release,
        parentReleaseId: "release-1",
      },
      moves: [{ ...beforeMove, power: 50 }],
    };

    const diff = diffCatalogSnapshots(before, after);
    const moveSection = diff.sections.find((section) => section.category === "moves");
    expect(moveSection).toEqual({ category: "moves", added: 0, removed: 0, changed: 1 });
    expect(formatReleaseDiff(diff)).toContain("moves: +0 -0 ~1");
    expect(before.moves[0]?.power).toBe(40);
  });
});
