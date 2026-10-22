import { z } from "zod";

/** Owner-only single-Pokémon grant. Product bundles remain separate decisions. */
export const ManualPremiumPokemonDeliverySchema = z
  .object({
    requestId: z.string().uuid(),
    playerId: z.string().uuid(),
    formId: z.string().uuid(),
    level: z.number().int().min(1).max(100),
    shiny: z.boolean().default(false),
    reason: z.string().trim().min(8).max(400),
  })
  .strict();
