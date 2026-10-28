import { describe, expect, it } from "vitest";
import type { CatalogSnapshot } from "../../src/modules/catalog/contracts.js";
import { auditStage2ContentReadiness } from "../../src/modules/catalog/stage2-content-readiness.js";

type Slice = Pick<CatalogSnapshot, "forms" | "moves" | "items" | "learnsets" | "evolutions" | "purchaseOffers">;
const baseline: Slice = {
  forms: [
    { formId: "bulba", speciesId: "s1", type1Id: "grass", type2Id: "poison", active: true },
    { formId: "ivy", speciesId: "s2", type1Id: "grass", type2Id: "poison", active: true },
  ],
  moves: [{
    moveId: "tackle", typeId: "normal", category: "PHYSICAL", power: 40,
    accuracy: 100, priority: 0, maxPp: 35, effectKey: null, effectConfig: {}, active: true,
  }],
  items: [{
    itemId: "evo-stone", itemKind: "EVOLUTION", effectKey: null, effectConfig: {}, active: true,
  }],
  learnsets: [
    { formId: "bulba", moveId: "tackle", learnMethod: "START", learnLevel: null, active: true },
    { formId: "ivy", moveId: "tackle", learnMethod: "START", learnLevel: null, active: true },
  ],
  evolutions: [],
  purchaseOffers: [],
};
const options = {
  learnsetVersionGroupByForm: new Map([["bulba", "scarlet-violet"], ["ivy", "scarlet-violet"]]),
  extraPlayerObtainableItemIds: new Set<string>(),
  advertisedOfferKeys: [] as string[],
};

describe("stage2 public catalog readiness (no gameplay mutations)", () => {
  it("accepts internally consistent versioned forms", () => {
    expect(auditStage2ContentReadiness(baseline, options)).toEqual([]);
  });

  it("blocks falsely advertised shop offers", () => {
    expect(auditStage2ContentReadiness(baseline, {
      ...options, advertisedOfferKeys: ["shop.evo-stone"],
    })).toContainEqual(expect.objectContaining({ code: "SHOP_OFFER_NOT_PUBLISHED" }));
  });

  it("blocks evolution items with no obtainable player source, then accepts published shop stock", () => {
    const withEvolution: Slice = {
      ...baseline,
      evolutions: [{ fromFormId: "bulba", toFormId: "ivy", triggerKind: "ITEM",
        triggerConfig: { itemId: "evo-stone" }, active: true }],
    };
    expect(auditStage2ContentReadiness(withEvolution, options)).toContainEqual(
      expect.objectContaining({ code: "UNOBTAINABLE_EVOLUTION_ITEM" }),
    );
    const stocked: Slice = {
      ...withEvolution,
      purchaseOffers: [{
        offerKey: "shop.evo-stone", itemId: "evo-stone",
        currencyId: "pokedollar", itemQuantity: "1", priceAmount: "2000",
        sortOrder: 1, active: true,
      }],
    };
    expect(auditStage2ContentReadiness(stocked, {
      ...options, advertisedOfferKeys: ["shop.evo-stone"],
    })).toEqual([]);
  });

  it("does not pass empty learnsets, unspecified generation or invalid targets", () => {
    const broken: Slice = {
      ...baseline,
      learnsets: baseline.learnsets.filter((entry) => entry.formId !== "ivy"),
      evolutions: [{ fromFormId: "bulba", toFormId: "missing", triggerKind: "LEVEL",
        triggerConfig: { level: 16 }, active: true }],
    };
    const problems = auditStage2ContentReadiness(broken, {
      ...options, learnsetVersionGroupByForm: new Map([["bulba", "scarlet-violet"]]),
    });
    expect(problems.map((problem) => problem.code)).toEqual(expect.arrayContaining([
      "MISSING_START_MOVES", "UNPINNED_LEARNSET_SOURCE", "UNKNOWN_EVOLUTION_TARGET",
    ]));
  });
});
