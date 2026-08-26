import { z } from "zod";

const uuid = z.string().uuid();
const conditionKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const sourceType = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9_.-]+$/);
const sourceId = z.string().trim().min(1).max(256);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ActivateEvolutionConditionInputSchema = z
  .object({
    pokemonInstanceId: uuid,
    conditionKey,
    sourceType,
    sourceId,
    correlationId: uuid,
    expectedRevision: revision.nullable(),
  })
  .strict();
export type ActivateEvolutionConditionInput = z.infer<typeof ActivateEvolutionConditionInputSchema>;

export const RevokeEvolutionConditionInputSchema = z
  .object({
    pokemonInstanceId: uuid,
    conditionKey,
    sourceType,
    sourceId,
    correlationId: uuid,
    expectedRevision: revision,
  })
  .strict();
export type RevokeEvolutionConditionInput = z.infer<typeof RevokeEvolutionConditionInputSchema>;

export const EvolutionConditionStateSchema = z
  .object({
    pokemonInstanceId: uuid,
    conditionKey,
    status: z.enum(["ACTIVE", "REVOKED"]),
    sourceType,
    sourceId,
    revision,
    replayed: z.boolean(),
  })
  .strict();
export type EvolutionConditionState = z.infer<typeof EvolutionConditionStateSchema>;
