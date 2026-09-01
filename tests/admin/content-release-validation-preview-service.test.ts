import { describe, expect, it, vi } from "vitest";
import {
  CatalogReleaseAdminService,
  type CatalogReleaseAdminRepository,
} from "../../src/modules/catalog/release-admin-service.js";
import type { CatalogSnapshotWithEffects } from "../../src/modules/catalog/validation.js";

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

const snapshot: CatalogSnapshotWithEffects = {
  release: {
    id: "release-draft",
    releaseNo: "2",
    status: "DRAFT",
    parentReleaseId: "release-parent",
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
      speciesId: "species-missing",
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
  regions: [{ regionId: "region-1", displayName: "Region", active: true, data: {} }],
  areas: [
    {
      areaId: "area-1",
      regionId: "region-1",
      displayName: "Area",
      active: true,
      data: {
        schemaVersion: 1,
        kind: "TOWN",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
      },
    },
  ],
  connections: [],
  formAbilities: [],
  learnsets: [],
  evolutions: [],
  starterOptions: [],
  purchaseOffers: [],
  encounterTables: [],
  parentCoverage: null,
};

describe("catalog release validation preview", () => {
  it("calculates authoritative blockers without opening a lifecycle transaction", async () => {
    const transaction = vi.fn();
    const readRelease = vi.fn();
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot);
    const repository = {
      transaction,
      readRelease,
      loadSnapshot,
    } as unknown as CatalogReleaseAdminRepository;
    const service = new CatalogReleaseAdminService(repository);

    const result = await service.previewValidation("release-draft");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.issues).toContainEqual({
      code: "FORM_SPECIES_MISSING",
      path: "forms.0.speciesId",
      message: "Form references a species absent from this release",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith("release-draft");
    expect(transaction).not.toHaveBeenCalled();
    expect(readRelease).not.toHaveBeenCalled();
  });
});
