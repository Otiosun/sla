import { z } from "zod";

export const ContentLifecycleStatusSchema = z.enum(["DRAFT", "VALIDATED", "PUBLISHED", "ARCHIVED"]);
export type ContentLifecycleStatus = z.infer<typeof ContentLifecycleStatusSchema>;

const basisPointsSchema = z.number().int().min(0).max(100_000);

export const RulesetConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    battle: z
      .object({
        statModel: z.literal("SIX_STATS"),
        physicalSpecialByMove: z.literal(true),
        ivEnabled: z.boolean(),
        evEnabled: z.boolean(),
        natureEnabled: z.boolean(),
        maxMoves: z.literal(4),
        ppEnabled: z.boolean(),
        criticalMultiplierBasisPoints: basisPointsSchema.min(10_000),
        accuracyEvasionEnabled: z.boolean(),
      })
      .strict(),
    capture: z
      .object({
        model: z.literal("POKEMON_INSPIRED_V1"),
        maxProbabilityBasisPoints: z.number().int().min(1).max(10_000),
      })
      .strict(),
    defeat: z
      .object({
        automaticMoneyLoss: z.literal(false),
      })
      .strict(),
    narrative: z
      .object({
        authority: z.literal("N0_FLAVOR_ONLY"),
      })
      .strict(),
  })
  .strict();
export type RulesetConfig = z.infer<typeof RulesetConfigSchema>;

const statusKeySchema = z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]);
const statKeySchema = z.enum(["ATTACK", "DEFENSE", "SP_ATTACK", "SP_DEFENSE", "SPEED"]);

export const EffectConfigSchemas = {
  "heal-hp": z.object({ amount: z.number().int().positive().max(9_999) }).strict(),
  "cure-status": z.object({ status: statusKeySchema }).strict(),
  "restore-pp": z.object({ amount: z.number().int().positive().max(99) }).strict(),
  "catch-modifier": z
    .object({ multiplierBasisPoints: z.number().int().min(1).max(100_000) })
    .strict(),
  "apply-status": z
    .object({ status: statusKeySchema, chanceBasisPoints: basisPointsSchema.max(10_000) })
    .strict(),
  "modify-stat-stage": z
    .object({
      stat: statKeySchema,
      stages: z
        .number()
        .int()
        .min(-6)
        .max(6)
        .refine((value) => value !== 0),
    })
    .strict(),
  "low-hp-type-boost": z
    .object({
      typeSlug: z.string().min(1).max(64),
      multiplierBasisPoints: z.number().int().min(10_001).max(100_000),
    })
    .strict(),
  "prevent-accuracy-drop": z.object({}).strict(),
  "run-away": z.object({}).strict(),
} as const;

export type EffectKey = keyof typeof EffectConfigSchemas;
export const EFFECT_KEYS = Object.freeze(Object.keys(EffectConfigSchemas) as EffectKey[]);

export function validateEffectConfig(
  effectKey: string | null,
  config: unknown,
): z.ZodSafeParseResult<unknown> {
  if (effectKey === null) {
    return z.object({}).strict().safeParse(config);
  }

  const schema = EffectConfigSchemas[effectKey as EffectKey];
  if (schema === undefined) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: ["effectKey"],
          message: `Unknown effect primitive: ${effectKey}`,
        },
      ]),
    };
  }
  return schema.safeParse(config);
}

export const EvolutionTriggerSchemas = {
  LEVEL: z.object({ level: z.number().int().min(2).max(100) }).strict(),
  ITEM: z.object({ itemId: z.string().uuid() }).strict(),
  CONDITION: z.object({ conditionKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
} as const;
export type EvolutionTriggerKind = keyof typeof EvolutionTriggerSchemas;

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface RulesetSnapshot {
  readonly id: string;
  readonly status: ContentLifecycleStatus;
  readonly config: unknown;
  readonly typeMatchups: readonly {
    readonly attackingTypeId: string;
    readonly defendingTypeId: string;
    readonly multiplierBasisPoints: number;
  }[];
}

export interface CatalogSnapshot {
  readonly release: {
    readonly id: string;
    readonly releaseNo: string;
    readonly status: ContentLifecycleStatus;
    readonly parentReleaseId: string | null;
    readonly defaultRulesetId: string;
  };
  readonly ruleset: RulesetSnapshot;
  readonly types: readonly {
    readonly typeId: string;
    readonly displayName: string;
    readonly active: boolean;
  }[];
  readonly species: readonly {
    readonly speciesId: string;
    readonly displayName: string;
    readonly active: boolean;
  }[];
  readonly forms: readonly {
    readonly formId: string;
    readonly speciesId: string;
    readonly type1Id: string;
    readonly type2Id: string | null;
    readonly active: boolean;
  }[];
  readonly moves: readonly {
    readonly moveId: string;
    readonly typeId: string;
    readonly category: "PHYSICAL" | "SPECIAL" | "STATUS";
    readonly power: number | null;
    readonly accuracy: number | null;
    readonly priority: number;
    readonly maxPp: number | null;
    readonly effectKey: string | null;
    readonly effectConfig: unknown;
    readonly active: boolean;
  }[];
  readonly abilities: readonly {
    readonly abilityId: string;
    readonly effectKey: string | null;
    readonly effectConfig: unknown;
    readonly active: boolean;
  }[];
  readonly items: readonly {
    readonly itemId: string;
    readonly itemKind: string;
    readonly effectKey: string | null;
    readonly effectConfig: unknown;
    readonly active: boolean;
  }[];
  readonly natures: readonly {
    readonly natureId: string;
    readonly increasedStat: string | null;
    readonly decreasedStat: string | null;
    readonly active: boolean;
  }[];
  readonly regions: readonly {
    readonly regionId: string;
    readonly displayName: string;
    readonly active: boolean;
    readonly data: unknown;
  }[];
  readonly areas: readonly {
    readonly areaId: string;
    readonly regionId: string;
    readonly displayName: string;
    readonly active: boolean;
    readonly data: unknown;
  }[];
  readonly connections: readonly {
    readonly connectionId: string;
    readonly connectionKey: string;
    readonly fromAreaId: string;
    readonly toAreaId: string;
    readonly accessRule: unknown;
    readonly active: boolean;
  }[];
  readonly formAbilities: readonly {
    readonly formId: string;
    readonly abilityId: string;
    readonly active: boolean;
  }[];
  readonly learnsets: readonly {
    readonly formId: string;
    readonly moveId: string;
    readonly learnMethod: string;
    readonly learnLevel: number | null;
    readonly active: boolean;
  }[];
  readonly evolutions: readonly {
    readonly fromFormId: string;
    readonly toFormId: string;
    readonly triggerKind: EvolutionTriggerKind;
    readonly triggerConfig: unknown;
    readonly active: boolean;
  }[];
  readonly starterOptions: readonly {
    readonly regionId: string;
    readonly formId: string;
    readonly starterLevel: number;
    readonly sortOrder: number;
    readonly active: boolean;
  }[];
  readonly purchaseOffers: readonly {
    readonly offerKey: string;
    readonly itemId: string;
    readonly currencyId: string;
    readonly itemQuantity: string;
    readonly priceAmount: string;
    readonly sortOrder: number;
    readonly active: boolean;
  }[];
  readonly encounterTables: readonly {
    readonly encounterTableId: string;
    readonly areaId: string;
    readonly active: boolean;
    readonly entries: readonly {
      readonly formId: string;
      readonly weight: string;
      readonly minLevel: number;
      readonly maxLevel: number;
      readonly active: boolean;
    }[];
  }[];
  readonly parentCoverage: CatalogCoverage | null;
}

export interface CatalogCoverage {
  readonly types: readonly string[];
  readonly species: readonly string[];
  readonly forms: readonly string[];
  readonly moves: readonly string[];
  readonly abilities: readonly string[];
  readonly items: readonly string[];
  readonly natures: readonly string[];
  readonly regions: readonly string[];
  readonly areas: readonly string[];
  readonly connections: readonly string[];
  readonly encounterTables: readonly string[];
}

export const CATALOG_DIFF_CATEGORIES = [
  "types",
  "species",
  "forms",
  "moves",
  "abilities",
  "items",
  "natures",
  "regions",
  "areas",
  "connections",
  "encounterTables",
  "formAbilities",
  "learnsets",
  "evolutions",
  "starterOptions",
  "purchaseOffers",
] as const;
export type CatalogDiffCategory = (typeof CATALOG_DIFF_CATEGORIES)[number];

export interface CatalogDiffSection {
  readonly category: CatalogDiffCategory;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

export interface CatalogDiff {
  readonly fromReleaseId: string;
  readonly toReleaseId: string;
  readonly sections: readonly CatalogDiffSection[];
}
