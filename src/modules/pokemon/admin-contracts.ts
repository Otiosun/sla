import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(512);
const expectedRevision = z.bigint().nonnegative();
const sourceToken = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const mutationMetadataSchema = z
  .object({
    sourceType: sourceToken,
    sourceId: z.string().trim().min(1).max(255),
    reason: z.string().trim().min(1).max(2000),
    actorType: z.enum(["SYSTEM", "ADMIN"]),
    actorId: uuid.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType === "SYSTEM" && value.actorId !== null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "SYSTEM Pokemon mutation must not carry actorId",
      });
    }
    if (value.actorType === "ADMIN" && value.actorId === null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "ADMIN Pokemon mutation requires actorId",
      });
    }
  });

const commonMutationFields = {
  playerId: uuid,
  pokemonInstanceId: uuid,
  expectedRevision,
  idempotencyKey,
  correlationId: uuid,
  metadata: mutationMetadataSchema,
} as const;

const ivsSchema = z
  .object({
    hp: z.number().int().min(0).max(31),
    attack: z.number().int().min(0).max(31),
    defense: z.number().int().min(0).max(31),
    spAttack: z.number().int().min(0).max(31),
    spDefense: z.number().int().min(0).max(31),
    speed: z.number().int().min(0).max(31),
  })
  .strict();

const signedSafeDeltaSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => value !== 0, "XP correction delta must be non-zero");

export const CreatePokemonInputSchema = z
  .object({
    playerId: uuid,
    formId: uuid,
    level: z.number().int().min(1).max(100),
    natureId: uuid,
    abilityId: uuid,
    ivs: ivsSchema,
    moveIds: z.array(uuid).min(1).max(4),
    idempotencyKey,
    correlationId: uuid,
    metadata: mutationMetadataSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.moveIds).size !== value.moveIds.length) {
      context.addIssue({
        code: "custom",
        path: ["moveIds"],
        message: "Pokemon creation moves must be unique",
      });
    }
  });
export type CreatePokemonInput = z.infer<typeof CreatePokemonInputSchema>;

export const CorrectPokemonProgressInputSchema = z
  .object({ ...commonMutationFields, deltaXp: signedSafeDeltaSchema })
  .strict();
export type CorrectPokemonProgressInput = z.infer<typeof CorrectPokemonProgressInputSchema>;

export const PokemonRosterPlacementSchema = z.discriminatedUnion("placementKind", [
  z
    .object({
      placementKind: z.literal("TEAM"),
      boxNo: z.null(),
      slotNo: z.number().int().min(1).max(6),
    })
    .strict(),
  z
    .object({
      placementKind: z.literal("BOX"),
      boxNo: z.number().int().min(1).max(10_000),
      slotNo: z.number().int().min(1).max(1_000_000),
    })
    .strict(),
]);
export type PokemonRosterPlacement = z.infer<typeof PokemonRosterPlacementSchema>;

export const MovePokemonRosterInputSchema = z
  .object({ ...commonMutationFields, target: PokemonRosterPlacementSchema })
  .strict();
export type MovePokemonRosterInput = z.infer<typeof MovePokemonRosterInputSchema>;

export const CorrectPokemonHpInputSchema = z
  .object({
    ...commonMutationFields,
    currentHp: z.number().int().min(0).max(65_535),
  })
  .strict();
export type CorrectPokemonHpInput = z.infer<typeof CorrectPokemonHpInputSchema>;

export const MajorPokemonStatusSchema = z.enum(["BURN", "POISON", "PARALYSIS", "SLEEP", "FREEZE"]);
export type MajorPokemonStatus = z.infer<typeof MajorPokemonStatusSchema>;

export const CorrectPokemonStatusInputSchema = z
  .object({
    ...commonMutationFields,
    status: MajorPokemonStatusSchema.nullable(),
    counter: z.number().int().min(0).max(10).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === null && value.counter !== null) {
      context.addIssue({
        code: "custom",
        path: ["counter"],
        message: "Clearing Pokemon status cannot keep a status counter",
      });
    }
  });
export type CorrectPokemonStatusInput = z.infer<typeof CorrectPokemonStatusInputSchema>;

export const ApplyPokemonEffectInputSchema = z
  .object({ ...commonMutationFields, effectId: uuid })
  .strict();
export type ApplyPokemonEffectInput = z.infer<typeof ApplyPokemonEffectInputSchema>;

export const RemovePokemonEffectInputSchema = z
  .object({ ...commonMutationFields, activeEffectId: uuid })
  .strict();
export type RemovePokemonEffectInput = z.infer<typeof RemovePokemonEffectInputSchema>;

export const ArchivePokemonInputSchema = z.object(commonMutationFields).strict();
export type ArchivePokemonInput = z.infer<typeof ArchivePokemonInputSchema>;

export const PokemonOwnerOperationKindSchema = z.enum([
  "CREATE",
  "PROGRESS_CORRECT",
  "ROSTER_MOVE",
  "HP_CORRECT",
  "STATUS_CORRECT",
  "EFFECT_APPLY",
  "EFFECT_REMOVE",
  "ARCHIVE",
]);
export type PokemonOwnerOperationKind = z.infer<typeof PokemonOwnerOperationKindSchema>;

export const PokemonOwnerMutationResultSchema = z
  .object({
    pokemonInstanceId: uuid,
    operationKind: PokemonOwnerOperationKindSchema,
    beforeRevision: z.string().regex(/^[0-9]+$/).nullable(),
    afterRevision: z.string().regex(/^[0-9]+$/),
    beforeData: z.record(z.string(), z.unknown()),
    afterData: z.record(z.string(), z.unknown()),
    replayed: z.boolean(),
  })
  .strict();
export type PokemonOwnerMutationResult = z.infer<typeof PokemonOwnerMutationResultSchema>;
