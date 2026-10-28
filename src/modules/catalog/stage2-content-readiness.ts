import { EvolutionTriggerSchemas, type CatalogSnapshot } from "./contracts.js";

export interface Stage2ContentProblem {
  readonly code:
    | "MISSING_START_MOVES"
    | "UNKNOWN_OR_INACTIVE_MOVE"
    | "UNPINNED_LEARNSET_SOURCE"
    | "UNKNOWN_EVOLUTION_TARGET"
    | "INVALID_EVOLUTION_RULE"
    | "UNOBTAINABLE_EVOLUTION_ITEM"
    | "SHOP_OFFER_NOT_PUBLISHED";
  readonly entityId: string;
  readonly detail: string;
}

export interface Stage2ReleaseAuditOptions {
  /** Per-form inspected and version-locked source (e.g. scarlet-violet). */
  readonly learnsetVersionGroupByForm: ReadonlyMap<string, string>;
  /** Verified player-facing external rewards/drops. Admin test grants do not count. */
  readonly extraPlayerObtainableItemIds: ReadonlySet<string>;
  /** Catalog items advertised as buyable in the current bot/Hub. */
  readonly advertisedOfferKeys: readonly string[];
}

/**
 * Read-only release gate. A published release with incomplete source coverage
 * is not considered Stage2-ready, even if individual DB transactions pass.
 * Does NOT seed, alter content, compensate users or switch ACTIVE releases.
 */
export function auditStage2ContentReadiness(
  release: Pick<
    CatalogSnapshot,
    "forms" | "moves" | "items" | "learnsets" | "evolutions" | "purchaseOffers"
  >,
  options: Stage2ReleaseAuditOptions,
): readonly Stage2ContentProblem[] {
  const issues: Stage2ContentProblem[] = [];
  const activeForms = release.forms.filter((form) => form.active);
  const forms = new Set(activeForms.map((form) => form.formId));
  const moves = new Set(release.moves.filter((move) => move.active).map((move) => move.moveId));
  const items = new Set(release.items.filter((item) => item.active).map((item) => item.itemId));
  const offers = new Map(
    release.purchaseOffers.filter((offer) => offer.active).map((offer) => [offer.offerKey, offer]),
  );
  const obtainable = new Set([
    ...options.extraPlayerObtainableItemIds,
    ...[...offers.values()].map((offer) => offer.itemId),
  ]);
  for (const form of activeForms) {
    const entries = release.learnsets.filter((entry) => entry.active && entry.formId === form.formId);
    if (!entries.some((entry) => entry.learnMethod === "START")) {
      issues.push({
        code: "MISSING_START_MOVES", entityId: form.formId,
        detail: "No starter move can initialize this Pokémon safely",
      });
    }
    if (!options.learnsetVersionGroupByForm.has(form.formId)) {
      issues.push({
        code: "UNPINNED_LEARNSET_SOURCE", entityId: form.formId,
        detail: "No verified source version for the current form learnset",
      });
    }
    for (const entry of entries) {
      if (!moves.has(entry.moveId)) {
        issues.push({
          code: "UNKNOWN_OR_INACTIVE_MOVE", entityId: form.formId,
          detail: `Learnset points to unknown or inactive move ${entry.moveId}`,
        });
      }
    }
  }
  for (const rule of release.evolutions.filter((entry) => entry.active && forms.has(entry.fromFormId))) {
    if (!forms.has(rule.toFormId)) {
      issues.push({
        code: "UNKNOWN_EVOLUTION_TARGET", entityId: rule.fromFormId,
        detail: `Target form ${rule.toFormId} is not active`,
      });
    }
    const parsed = EvolutionTriggerSchemas[rule.triggerKind].safeParse(rule.triggerConfig);
    if (!parsed.success) {
      issues.push({
        code: "INVALID_EVOLUTION_RULE", entityId: rule.fromFormId,
        detail: `Trigger ${rule.triggerKind} is not in the canonical schema`,
      });
      continue;
    }
    if (rule.triggerKind === "ITEM") {
      const itemRule = EvolutionTriggerSchemas.ITEM.safeParse(rule.triggerConfig);
      if (!itemRule.success || !items.has(itemRule.data.itemId) || !obtainable.has(itemRule.data.itemId)) {
        issues.push({
          code: "UNOBTAINABLE_EVOLUTION_ITEM", entityId: rule.fromFormId,
          detail: "The required evolution item has no verified player-facing acquisition source",
        });
      }
    }
  }
  for (const key of options.advertisedOfferKeys) {
    const offer = offers.get(key);
    if (offer === undefined || !items.has(offer.itemId)) {
      issues.push({
        code: "SHOP_OFFER_NOT_PUBLISHED", entityId: key,
        detail: "The shop is advertising an offer absent from the published active purchase catalog",
      });
    }
  }
  return issues;
}
