import { z } from "zod";
import type { EncounterConditions } from "./encounter-contracts.js";

export const ContentLifecycleStatusSchema = z.enum(["DRAFT", "VALIDATED", "PUBLISHED", "ARCHIVED"]);
export type ContentLifecycleStatus = z.infer<typeof ContentLifecycleStatusSchema>;

const basisPointsSchema = z.number().int().min(0).max(100_000);
const captureEncounterStatusSchema = z.enum(["ENGAGED", "IN_BATTLE"]);

export const BattleMoveFlagsSchema = z.union([
  z.object({}).strict(),
  z.object({ schemaVersion: z.literal(1), makesContact: z.boolean() }).strict(),
]);
export type BattleMoveFlags = z.infer<typeof BattleMoveFlagsSchema>;

const trainerUnlockSchema = z
  .object({
    level: z.number().int().min(2).max(100),
    unlockKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/),
  })
  .strict();

export const ProgressionRulesSchema = z
  .object({
    pokemon: z
      .object({
        xpCurve: z.literal("CUBIC_DELTA_V1"),
        battleRewardModel: z.literal("BASE_EXP_LEVEL_DIV_7_V1"),
        rewardRecipient: z.literal("ACTIVE_WINNER_V1"),
        levelCap: z.literal(100),
        hpOnLevelUp: z.literal("ADD_MAX_HP_DELTA_IF_ALIVE_V1"),
        fullMoveSlotsPolicy: z.literal("PENDING_CHOICE_V1"),
        autoLevelEvolution: z.literal(true),
      })
      .strict(),
    trainer: z
      .object({
        visiblePointsName: z.enum(["XP de Treinador", "Insígnia"]),
        levelCurve: z.enum(["QUADRATIC_100_V1", "LINEAR_100_V1"]),
        levelCap: z.literal(100),
        pointsPerWonBattle: z.number().int().min(1).max(1_000_000),
        unlocks: z.array(trainerUnlockSchema).max(64),
      })
      .strict()
      .superRefine((trainer, context) => {
        const expectedName = trainer.levelCurve === "LINEAR_100_V1" ? "Insígnia" : "XP de Treinador";
        if (trainer.visiblePointsName !== expectedName) {
          context.addIssue({
            code: "custom",
            path: ["visiblePointsName"],
            message: "trainer progression label must match the versioned level curve",
          });
        }
        const levels = new Set<number>();
        const keys = new Set<string>();
        for (const [index, unlock] of trainer.unlocks.entries()) {
          if (levels.has(unlock.level)) {
            context.addIssue({
              code: "custom",
              path: ["unlocks", index, "level"],
              message: "trainer unlock levels must be unique",
            });
          }
          if (keys.has(unlock.unlockKey)) {
            context.addIssue({
              code: "custom",
              path: ["unlocks", index, "unlockKey"],
              message: "trainer unlock keys must be unique",
            });
          }
          levels.add(unlock.level);
          keys.add(unlock.unlockKey);
        }
      }),
  })
  .strict();
export type ProgressionRules = z.infer<typeof ProgressionRulesSchema>;

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
        stabMultiplierBasisPoints: basisPointsSchema.min(1).optional(),
        damageRandomMinBasisPoints: z.number().int().min(1).max(10_000).optional(),
        damageRandomMaxBasisPoints: z.number().int().min(1).max(10_000).optional(),
        switchConsumesTurn: z.boolean().optional(),
      })
      .strict(),
    capture: z
      .object({
        model: z.literal("POKEMON_INSPIRED_V1"),
        maxProbabilityBasisPoints: z.number().int().min(1).max(10_000),
        allowedEncounterStates: z.array(captureEncounterStatusSchema).min(1).max(2).optional(),
      })
      .strict(),
    encounter: z.object({ expirationSeconds: z.number().int().min(30).max(86_400) }).strict().optional(),
    defeat: z.object({ automaticMoneyLoss: z.literal(false) }).strict(),
    narrative: z.object({ authority: z.literal("N0_FLAVOR_ONLY") }).strict(),
    progression: ProgressionRulesSchema.optional(),
  })
  .strict();
export type RulesetConfig = z.infer<typeof RulesetConfigSchema>;

const statusKeySchema = z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]);
const statKeySchema = z.enum([
  "ATTACK",
  "DEFENSE",
  "SP_ATTACK",
  "SP_DEFENSE",
  "SPEED",
  "ACCURACY",
  "EVASION",
]);
const statusChanceSchema = z
  .object({ status: statusKeySchema, chanceBasisPoints: basisPointsSchema.max(10_000) })
  .strict();

export const EffectConfigSchemas = {
  "heal-hp": z.object({ amount: z.number().int().positive().max(9_999) }).strict(),
  "cure-status": z.object({ status: statusKeySchema }).strict(),
  "restore-pp": z.object({ amount: z.number().int().positive().max(99) }).strict(),
  "catch-modifier": z.object({ multiplierBasisPoints: z.number().int().min(1).max(100_000) }).strict(),
  "apply-status": statusChanceSchema,
  "apply-status-on-contact-received": statusChanceSchema,
  "modify-stat-stage": z
    .object({
      stat: statKeySchema,
      stages: z.number().int().min(-6).max(6).refine((value) => value !== 0),
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
  if (effectKey === null) return z.object({}).strict().safeParse(config);
  const schema = EffectConfigSchemas[effectKey as EffectKey];
  if (schema === undefined) {
    return {
      success: false,
      error: new z.ZodError([
        { code: "custom", path: ["effectKey"], message: `Unknown effect primitive: ${effectKey}` },
      ]),
    };
  }
  return schema.safeParse(config);
}

export const RewardProgramSchema = z
  .object({
    version: z.literal(1),
    grants: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("ITEM"), itemId: z.string().uuid(), quantity: z.number().int().positive().max(1_000_000_000) }).strict(),
          z.object({ kind: z.literal("CURRENCY"), currencyId: z.string().uuid(), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
          z.object({ kind: z.literal("TRAINER_POINTS"), amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type RewardProgram = z.infer<typeof RewardProgramSchema>;

export const EvolutionTriggerSchemas = {
  LEVEL: z.object({ level: z.number().int().min(2).max(100) }).strict(),
  ITEM: z.object({ itemId: z.string().uuid() }).strict(),
  CONDITION: z.object({ conditionKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
} as const;
export type EvolutionTriggerKind = keyof typeof EvolutionTriggerSchemas;

export interface ValidationIssue { readonly code: string; readonly path: string; readonly message: string }
export interface ValidationReport { readonly valid: boolean; readonly issues: readonly ValidationIssue[] }

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
  readonly types: readonly { readonly typeId: string; readonly displayName: string; readonly active: boolean }[];
  readonly species: readonly { readonly speciesId: string; readonly displayName: string; readonly active: boolean }[];
  readonly forms: readonly { readonly formId: string; readonly speciesId: string; readonly type1Id: string; readonly type2Id: string | null; readonly active: boolean }[];
  readonly moves: readonly { readonly moveId: string; readonly typeId: string; readonly category: "PHYSICAL" | "SPECIAL" | "STATUS"; readonly power: number | null; readonly accuracy: number | null; readonly priority: number; readonly maxPp: number | null; readonly effectKey: string | null; readonly effectConfig: unknown; readonly flags?: BattleMoveFlags; readonly active: boolean }[];
  readonly abilities: readonly { readonly abilityId: string; readonly effectKey: string | null; readonly effectConfig: unknown; readonly active: boolean }[];
  readonly items: readonly { readonly itemId: string; readonly itemKind: string; readonly effectKey: string | null; readonly effectConfig: unknown; readonly active: boolean }[];
  readonly natures: readonly { readonly natureId: string; readonly increasedStat: string | null; readonly decreasedStat: string | null; readonly active: boolean }[];
  readonly effects: readonly { readonly effectId: string; readonly scope: "PLAYER" | "POKEMON" | "BATTLE_PARTICIPANT" | "AREA"; readonly stackingPolicy: string; readonly durationModel: string; readonly rules: unknown; readonly active: boolean }[];
  readonly rewards: readonly { readonly rewardId: string; readonly displayName: string; readonly program: unknown; readonly active: boolean }[];
  readonly regions: readonly { readonly regionId: string; readonly displayName: string; readonly active: boolean; readonly data: unknown }[];
  readonly areas: readonly { readonly areaId: string; readonly regionId: string; readonly displayName: string; readonly active: boolean; readonly data: unknown }[];
  readonly connections: readonly { readonly connectionId: string; readonly connectionKey: string; readonly fromAreaId: string; readonly toAreaId: string; readonly accessRule: unknown; readonly active: boolean }[];
  readonly formAbilities: readonly { readonly formId: string; readonly abilityId: string; readonly active: boolean }[];
  readonly learnsets: readonly { readonly formId: string; readonly moveId: string; readonly learnMethod: string; readonly learnLevel: number | null; readonly active: boolean }[];
  readonly evolutions: readonly { readonly fromFormId: string; readonly toFormId: string; readonly triggerKind: EvolutionTriggerKind; readonly triggerConfig: unknown; readonly active: boolean }[];
  readonly starterOptions: readonly { readonly regionId: string; readonly formId: string; readonly starterLevel: number; readonly sortOrder: number; readonly active: boolean }[];
  readonly purchaseOffers: readonly { readonly offerKey: string; readonly itemId: string; readonly currencyId: string; readonly itemQuantity: string; readonly priceAmount: string; readonly sortOrder: number; readonly active: boolean }[];
  readonly encounterTables: readonly {
    readonly encounterTableId: string;
    readonly areaId: string;
    readonly active: boolean;
    readonly conditions: EncounterConditions;
    readonly entries: readonly { readonly formId: string; readonly weight: string; readonly minLevel: number; readonly maxLevel: number; readonly active: boolean; readonly conditions: EncounterConditions }[];
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
  readonly effects: readonly string[];
  readonly rewards: readonly string[];
  readonly regions: readonly string[];
  readonly areas: readonly string[];
  readonly connections: readonly string[];
  readonly encounterTables: readonly string[];
}

export const CATALOG_DIFF_CATEGORIES = [
  "types", "species", "forms", "moves", "abilities", "items", "natures", "effects", "rewards",
  "regions", "areas", "connections", "encounterTables", "formAbilities", "learnsets", "evolutions",
  "starterOptions", "purchaseOffers",
] as const;
export type CatalogDiffCategory = (typeof CATALOG_DIFF_CATEGORIES)[number];
export interface CatalogDiffSection { readonly category: CatalogDiffCategory; readonly added: number; readonly removed: number; readonly changed: number }
export interface CatalogDiff { readonly fromReleaseId: string; readonly toReleaseId: string; readonly sections: readonly CatalogDiffSection[] }
