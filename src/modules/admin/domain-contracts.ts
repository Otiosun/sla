import { z } from "zod";

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
  }, "trainer progression delta must fit the safe integer range and be non-zero");

export const AdminTrainerProgressAdjustInputSchema = z
  .object({ playerId: uuidSchema, delta: safeSignedProgressDeltaSchema })
  .strict();
export type AdminTrainerProgressAdjustInput = z.infer<typeof AdminTrainerProgressAdjustInputSchema>;
