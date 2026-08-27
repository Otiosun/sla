import { z } from "zod";
import {
  MajorPokemonStatusSchema,
  PokemonRosterPlacementSchema,
} from "../pokemon/admin-contracts.js";

const uuidSchema = z.string().uuid();
const signedDeltaSchema = z
  .string()
  .regex(/^-?[1-9][0-9]*$/)
  .refine((value) => {
    try {
      const parsed = BigInt(value);
      return parsed >= -9_223_372_036_854_775_807n && parsed <= 9_223_372_036_854_775_807n;
    } catch {
      return false;
    }
  }, "delta must fit PostgreSQL bigint and be non-zero");

export const AdminInventoryAdjustInputSchema = z
  .object({
    playerId: uuidSchema,
    itemId: uuidSchema,
    delta: signedDeltaSchema,
  })
  .strict();
export type AdminInventoryAdjustInput = z.infer<typeof AdminInventoryAdjustInputSchema>;

export const AdminWalletAdjustInputSchema = z
  .object({
    playerId: uuidSchema,
    currencyId: uuidSchema,
    delta: signedDeltaSchema,
  })
  .strict();
export type AdminWalletAdjustInput = z.infer<typeof AdminWalletAdjustInputSchema>;

const safeSignedProgressDeltaSchema = z
  .string()
  .regex(/^-?[1-9][0-9]*$/)
  .refine((value) => {
    try {
      const parsed = BigInt(value);
      return (
        parsed >= BigInt(-Number.MAX_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      );
    } catch {
      return false;
    }
  }, "progression delta must fit the safe integer range and be non-zero");

export const AdminTrainerProgressAdjustInputSchema = z
  .object({ playerId: uuidSchema, delta: safeSignedProgressDeltaSchema })
  .strict();
export type AdminTrainerProgressAdjustInput = z.infer<typeof AdminTrainerProgressAdjustInputSchema>;

const pokemonTargetFields = {
  playerId: uuidSchema,
  pokemonInstanceId: uuidSchema,
} as const;

const pokemonIvsSchema = z
  .object({
    hp: z.number().int().min(0).max(31),
    attack: z.number().int().min(0).max(31),
    defense: z.number().int().min(0).max(31),
    spAttack: z.number().int().min(0).max(31),
    spDefense: z.number().int().min(0).max(31),
    speed: z.number().int().min(0).max(31),
  })
  .strict();

export const AdminPokemonCreateInputSchema = z
  .object({
    playerId: uuidSchema,
    formId: uuidSchema,
    level: z.number().int().min(1).max(100),
    natureId: uuidSchema,
    abilityId: uuidSchema,
    ivs: pokemonIvsSchema,
    moveIds: z.array(uuidSchema).min(1).max(4),
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
export type AdminPokemonCreateInput = z.infer<typeof AdminPokemonCreateInputSchema>;

export const AdminPokemonProgressCorrectInputSchema = z
  .object({ ...pokemonTargetFields, deltaXp: safeSignedProgressDeltaSchema })
  .strict();
export type AdminPokemonProgressCorrectInput = z.infer<typeof AdminPokemonProgressCorrectInputSchema>;

export const AdminPokemonRosterMoveInputSchema = z
  .object({ ...pokemonTargetFields, target: PokemonRosterPlacementSchema })
  .strict();
export type AdminPokemonRosterMoveInput = z.infer<typeof AdminPokemonRosterMoveInputSchema>;

export const AdminPokemonHpCorrectInputSchema = z
  .object({
    ...pokemonTargetFields,
    currentHp: z.number().int().min(0).max(65_535),
  })
  .strict();
export type AdminPokemonHpCorrectInput = z.infer<typeof AdminPokemonHpCorrectInputSchema>;

export const AdminPokemonStatusCorrectInputSchema = z
  .object({
    ...pokemonTargetFields,
    status: MajorPokemonStatusSchema.nullable(),
    counter: z.number().int().min(0).max(10).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === null && value.counter !== null) {
      context.addIssue({
        code: "custom",
        path: ["counter"],
        message: "Clearing Pokemon status cannot keep a counter",
      });
    }
  });
export type AdminPokemonStatusCorrectInput = z.infer<typeof AdminPokemonStatusCorrectInputSchema>;

export const AdminPokemonEffectApplyInputSchema = z
  .object({ ...pokemonTargetFields, effectId: uuidSchema })
  .strict();
export type AdminPokemonEffectApplyInput = z.infer<typeof AdminPokemonEffectApplyInputSchema>;

export const AdminPokemonEffectRemoveInputSchema = z
  .object({ ...pokemonTargetFields, activeEffectId: uuidSchema })
  .strict();
export type AdminPokemonEffectRemoveInput = z.infer<typeof AdminPokemonEffectRemoveInputSchema>;

export const AdminPokemonArchiveInputSchema = z.object(pokemonTargetFields).strict();
export type AdminPokemonArchiveInput = z.infer<typeof AdminPokemonArchiveInputSchema>;
