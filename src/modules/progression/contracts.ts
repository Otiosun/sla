import { z } from "zod";

const uuid = z.string().uuid();
const safeNonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string().trim().min(1).max(512);

const signedSafeDelta = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => value !== 0, "delta must be non-zero");
const progressionSourceToken = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AdjustTrainerProgressInputSchema = z
  .object({
    playerId: uuid,
    delta: signedSafeDelta,
    idempotencyKey,
    correlationId: uuid,
    metadata: z
      .object({
        sourceType: progressionSourceToken,
        sourceId: z.string().trim().min(1).max(255),
        reason: z.string().trim().min(1).max(512),
        actorType: z.enum(["SYSTEM", "ADMIN"]),
        actorId: uuid.nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.actorType === "SYSTEM" && value.actorId !== null) {
          context.addIssue({
            code: "custom",
            path: ["actorId"],
            message: "SYSTEM adjustment must not carry actorId",
          });
        }
        if (value.actorType === "ADMIN" && value.actorId === null) {
          context.addIssue({
            code: "custom",
            path: ["actorId"],
            message: "ADMIN adjustment requires actorId",
          });
        }
      }),
  })
  .strict();
export type AdjustTrainerProgressInput = z.infer<typeof AdjustTrainerProgressInputSchema>;

export const TrainerProgressAdjustmentResultSchema = z
  .object({
    playerId: uuid,
    delta: signedSafeDelta,
    beforePoints: safeNonNegative,
    afterPoints: safeNonNegative,
    beforeLevel: z.number().int().min(1).max(100),
    afterLevel: z.number().int().min(1).max(100),
    rulesetId: uuid,
    activatedUnlockKeys: z.array(z.string().min(1).max(96)),
    revokedUnlockKeys: z.array(z.string().min(1).max(96)),
    replayed: z.boolean(),
  })
  .strict();
export type TrainerProgressAdjustmentResult = z.infer<typeof TrainerProgressAdjustmentResultSchema>;

export const ApplyBattleRewardInputSchema = z
  .object({ battleId: uuid, idempotencyKey, correlationId: uuid })
  .strict();
export type ApplyBattleRewardInput = z.infer<typeof ApplyBattleRewardInputSchema>;

export const ResolveMoveChoiceInputSchema = z
  .object({
    choiceId: uuid,
    playerId: uuid,
    replaceSlotNo: z.number().int().min(1).max(4).nullable(),
    correlationId: uuid,
  })
  .strict();
export type ResolveMoveChoiceInput = z.infer<typeof ResolveMoveChoiceInputSchema>;

export const EvolvePokemonInputSchema = z
  .object({
    playerId: uuid,
    pokemonInstanceId: uuid,
    idempotencyKey,
    correlationId: uuid,
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("LEVEL") }).strict(),
      z.object({ kind: z.literal("ITEM"), itemId: uuid }).strict(),
      z.object({ kind: z.literal("CONDITION") }).strict(),
    ]),
  })
  .strict();
export type EvolvePokemonInput = z.infer<typeof EvolvePokemonInputSchema>;

export const EvolutionResultSchema = z
  .object({
    pokemonInstanceId: uuid,
    fromFormId: uuid,
    toFormId: uuid,
    triggerKind: z.enum(["LEVEL", "ITEM", "CONDITION"]),
    beforeLevel: z.number().int().min(1).max(100),
    afterLevel: z.number().int().min(1).max(100),
    replayed: z.boolean(),
  })
  .strict();
export type EvolutionResult = z.infer<typeof EvolutionResultSchema>;

export const PokemonXpAwardResultSchema = z
  .object({
    pokemonInstanceId: uuid,
    offeredXp: safeNonNegative,
    awardedXp: safeNonNegative,
    discardedXp: safeNonNegative,
    beforeLevel: z.number().int().min(1).max(100),
    afterLevel: z.number().int().min(1).max(100),
    beforeXp: safeNonNegative,
    afterXp: safeNonNegative,
    learnedMoveIds: z.array(uuid),
    pendingMoveChoiceIds: z.array(uuid),
    evolutions: z.array(EvolutionResultSchema),
  })
  .strict();
export type PokemonXpAwardResult = z.infer<typeof PokemonXpAwardResultSchema>;

export const TrainerProgressResultSchema = z
  .object({
    playerId: uuid,
    pointsGained: safeNonNegative,
    beforePoints: safeNonNegative,
    afterPoints: safeNonNegative,
    beforeLevel: z.number().int().min(1).max(100),
    afterLevel: z.number().int().min(1).max(100),
    unlockKeys: z.array(z.string().min(1).max(96)),
  })
  .strict();
export type TrainerProgressResult = z.infer<typeof TrainerProgressResultSchema>;

export const BattleRewardResultSchema = z
  .object({
    battleId: uuid,
    playerId: uuid,
    pokemon: z.array(PokemonXpAwardResultSchema),
    trainer: TrainerProgressResultSchema,
    replayed: z.boolean(),
  })
  .strict();
export type BattleRewardResult = z.infer<typeof BattleRewardResultSchema>;

export const MoveChoiceResultSchema = z
  .object({
    choiceId: uuid,
    pokemonInstanceId: uuid,
    moveId: uuid,
    status: z.enum(["RESOLVED", "SKIPPED"]),
    replacedSlotNo: z.number().int().min(1).max(4).nullable(),
    replayed: z.boolean(),
  })
  .strict();
export type MoveChoiceResult = z.infer<typeof MoveChoiceResultSchema>;
