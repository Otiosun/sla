import {
  buildZhouliaEncounterPoolDraftPlans,
  type ZhouliaEncounterCatalogConditions,
} from "./zhoulia-catalog-adapter.js";
import { ZHOULIA_TYPED_CONTENT_V1, type ZhouliaContentBundle } from "./zhoulia-content.js";

export interface ZhouliaEncounterBalanceBand {
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly speciesWeight: number;
}

export interface ZhouliaBalancedEncounterEntry {
  readonly speciesKey: string;
  readonly weight: number;
  readonly minLevel: number;
  readonly maxLevel: number;
}

export interface ZhouliaBalancedEncounterPlan {
  readonly identity: string;
  readonly areaIdentity: string;
  readonly tableSlug: string;
  readonly label: string;
  readonly conditions: ZhouliaEncounterCatalogConditions;
  readonly entries: readonly ZhouliaBalancedEncounterEntry[];
  readonly balancePolicyVersion: 1;
}

export const ZHOULIA_ENCOUNTER_BALANCE_V1: Readonly<Record<string, ZhouliaEncounterBalanceBand>> =
  Object.freeze({
    "zhoulia.area.vila-dos-arrozais": Object.freeze({
      minLevel: 2,
      maxLevel: 5,
      speciesWeight: 100,
    }),
    "zhoulia.area.campos-de-yun": Object.freeze({
      minLevel: 4,
      maxLevel: 8,
      speciesWeight: 100,
    }),
  });

function validateBand(areaIdentity: string, band: ZhouliaEncounterBalanceBand): void {
  if (
    !Number.isSafeInteger(band.minLevel) ||
    !Number.isSafeInteger(band.maxLevel) ||
    band.minLevel < 1 ||
    band.maxLevel < band.minLevel ||
    band.maxLevel > 100
  ) {
    throw new Error(`Invalid encounter level band for ${areaIdentity}`);
  }
  if (!Number.isSafeInteger(band.speciesWeight) || band.speciesWeight <= 0) {
    throw new Error(`Invalid encounter species weight for ${areaIdentity}`);
  }
}

export function buildBalancedZhouliaEncounterPlans(
  bundle: ZhouliaContentBundle = ZHOULIA_TYPED_CONTENT_V1,
  balance: Readonly<Record<string, ZhouliaEncounterBalanceBand>> = ZHOULIA_ENCOUNTER_BALANCE_V1,
): readonly ZhouliaBalancedEncounterPlan[] {
  const pending = buildZhouliaEncounterPoolDraftPlans(bundle);
  return pending.map((pool) => {
    const band = balance[pool.areaIdentity];
    if (band === undefined) {
      throw new Error(`Missing encounter balance band for ${pool.areaIdentity}`);
    }
    validateBand(pool.areaIdentity, band);
    return {
      identity: pool.identity,
      areaIdentity: pool.areaIdentity,
      tableSlug: pool.tableSlug,
      label: pool.label,
      conditions: pool.conditions,
      entries: pool.speciesKeys.map((speciesKey) => ({
        speciesKey,
        weight: band.speciesWeight,
        minLevel: band.minLevel,
        maxLevel: band.maxLevel,
      })),
      balancePolicyVersion: 1,
    };
  });
}
