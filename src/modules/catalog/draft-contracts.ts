import { z } from "zod";
import { BattleMoveFlagsSchema, validateEffectConfig } from "./contracts.js";
import { EncounterConditionsSchema } from "./encounter-contracts.js";
import { EffectProgramSchema } from "./validation.js";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const displayNameSchema = z.string().trim().min(1).max(160);
const tokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const effectKeySchema = z.string().trim().min(1).max(64).nullable();

function withEffectValidation<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    const effectKey = record.effectKey;
    const effectConfig = record.effectConfig;
    const parsed = validateEffectConfig(typeof effectKey === "string" ? effectKey : null, effectConfig);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["effectConfig", ...issue.path],
          message: issue.message,
        });
      }
    }
  });
}

export const CatalogDraftResourceKindSchema = z.enum([
  "SPECIES",
  "MOVE",
  "ITEM",
  "AREA",
  "ENCOUNTER_TABLE",
  "REWARD",
  "EFFECT",
]);
export type CatalogDraftResourceKind = z.infer<typeof CatalogDraftResourceKindSchema>;

const speciesBodySchema = z
  .object({
    displayName: displayNameSchema,
    catchRate: z.number().int().nonnegative().max(1_000_000).nullable(),
    baseExp: z.number().int().nonnegative().max(1_000_000).nullable(),
    data: jsonObjectSchema,
  })
  .strict();

const moveBodySchema = withEffectValidation(
  z
    .object({
      displayName: displayNameSchema,
      typeId: z.string().uuid(),
      category: z.enum(["PHYSICAL", "SPECIAL", "STATUS"]),
      power: z.number().int().nonnegative().max(1_000_000).nullable(),
      accuracy: z.number().int().min(0).max(100).nullable(),
      priority: z.number().int().min(-32).max(32),
      maxPp: z.number().int().positive().max(255).nullable(),
      effectKey: effectKeySchema,
      effectConfig: jsonObjectSchema,
      flags: BattleMoveFlagsSchema,
    })
    .strict(),
);

const itemBodySchema = withEffectValidation(
  z
    .object({
      displayName: displayNameSchema,
      itemKind: tokenSchema,
      effectKey: effectKeySchema,
      effectConfig: jsonObjectSchema,
    })
    .strict(),
);

const areaBodySchema = z
  .object({
    displayName: displayNameSchema,
    data: jsonObjectSchema,
  })
  .strict();

export const CatalogDraftEncounterEntrySchema = z
  .object({
    formId: z.string().uuid(),
    weight: z.string().regex(/^[1-9][0-9]{0,17}$/),
    minLevel: z.number().int().min(1).max(100),
    maxLevel: z.number().int().min(1).max(100),
    active: z.boolean().default(true),
    conditions: EncounterConditionsSchema,
  })
  .strict()
  .refine((entry) => entry.minLevel <= entry.maxLevel, {
    message: "minLevel must be <= maxLevel",
    path: ["maxLevel"],
  });

const encounterBodySchema = z
  .object({
    conditions: EncounterConditionsSchema,
    entries: z.array(CatalogDraftEncounterEntrySchema).min(1).max(512),
  })
  .strict();

export const RewardProgramSchema = z
  .object({
    version: z.literal(1),
    grants: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("ITEM"),
              itemId: z.string().uuid(),
              quantity: z.number().int().positive().max(1_000_000_000),
            })
            .strict(),
          z
            .object({
              kind: z.literal("CURRENCY"),
              currencyId: z.string().uuid(),
              amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
          z
            .object({
              kind: z.literal("TRAINER_POINTS"),
              amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();

const rewardBodySchema = z
  .object({
    displayName: displayNameSchema,
    program: RewardProgramSchema,
  })
  .strict();

const effectBodySchema = z
  .object({
    scope: z.enum(["PLAYER", "POKEMON", "BATTLE_PARTICIPANT", "AREA"]),
    stackingPolicy: tokenSchema,
    durationModel: tokenSchema,
    rules: EffectProgramSchema,
  })
  .strict();

export const CatalogDraftCreateResourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("SPECIES"),
      slug: slugSchema,
      nationalDex: z.number().int().min(1).max(65535),
      ...speciesBodySchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("MOVE"),
      slug: slugSchema,
      ...moveBodySchema.shape,
    })
    .strict()
    .superRefine((value, context) => {
      const parsed = moveBodySchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
    }),
  z
    .object({
      kind: z.literal("ITEM"),
      slug: slugSchema,
      ...itemBodySchema.shape,
    })
    .strict()
    .superRefine((value, context) => {
      const parsed = itemBodySchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
    }),
  z
    .object({
      kind: z.literal("AREA"),
      regionId: z.string().uuid(),
      slug: slugSchema,
      ...areaBodySchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ENCOUNTER_TABLE"),
      areaId: z.string().uuid(),
      slug: slugSchema,
      ...encounterBodySchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("REWARD"),
      slug: slugSchema,
      ...rewardBodySchema.shape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("EFFECT"),
      slug: slugSchema,
      ...effectBodySchema.shape,
    })
    .strict(),
]);
export type CatalogDraftCreateResource = z.infer<typeof CatalogDraftCreateResourceSchema>;

export const CatalogDraftReplaceResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SPECIES"), ...speciesBodySchema.shape }).strict(),
  z
    .object({ kind: z.literal("MOVE"), ...moveBodySchema.shape })
    .strict()
    .superRefine((value, context) => {
      const parsed = moveBodySchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
    }),
  z
    .object({ kind: z.literal("ITEM"), ...itemBodySchema.shape })
    .strict()
    .superRefine((value, context) => {
      const parsed = itemBodySchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
    }),
  z.object({ kind: z.literal("AREA"), ...areaBodySchema.shape }).strict(),
  z.object({ kind: z.literal("ENCOUNTER_TABLE"), ...encounterBodySchema.shape }).strict(),
  z.object({ kind: z.literal("REWARD"), ...rewardBodySchema.shape }).strict(),
  z.object({ kind: z.literal("EFFECT"), ...effectBodySchema.shape }).strict(),
]);
export type CatalogDraftReplaceResource = z.infer<typeof CatalogDraftReplaceResourceSchema>;

export const CatalogDraftCreateInputSchema = z
  .object({
    releaseId: z.string().uuid(),
    resource: CatalogDraftCreateResourceSchema,
  })
  .strict();
export type CatalogDraftCreateInput = z.infer<typeof CatalogDraftCreateInputSchema>;

export const CatalogDraftReplaceInputSchema = z
  .object({
    releaseId: z.string().uuid(),
    resourceId: z.string().uuid(),
    resource: CatalogDraftReplaceResourceSchema,
  })
  .strict();
export type CatalogDraftReplaceInput = z.infer<typeof CatalogDraftReplaceInputSchema>;

export const CatalogDraftDeactivateInputSchema = z
  .object({
    releaseId: z.string().uuid(),
    resourceKind: CatalogDraftResourceKindSchema,
    resourceId: z.string().uuid(),
  })
  .strict();
export type CatalogDraftDeactivateInput = z.infer<typeof CatalogDraftDeactivateInputSchema>;

export const CatalogDraftInspectInputSchema = CatalogDraftDeactivateInputSchema;
export type CatalogDraftInspectInput = CatalogDraftDeactivateInput;

export interface CatalogDraftMutationMetadata {
  readonly sourceType: "ADMIN_OPERATION" | "SYSTEM";
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: "ADMIN" | "SYSTEM";
  readonly actorId: string | null;
}

export interface CatalogDraftMutationResult {
  readonly operationKind: "CREATE" | "REPLACE" | "DEACTIVATE";
  readonly resourceKind: CatalogDraftResourceKind;
  readonly resourceId: string;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly beforeData: Readonly<Record<string, unknown>> | null;
  readonly afterData: Readonly<Record<string, unknown>>;
  readonly replayed: boolean;
}

export interface CatalogDraftResourceView extends Readonly<Record<string, unknown>> {
  readonly releaseId: string;
  readonly releaseRevision: string;
  readonly releaseStatus: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly resourceKind: CatalogDraftResourceKind;
  readonly resourceId: string;
  readonly active: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}
