import { z } from "zod";

/** Manual item grants use the already-audited inventory.adjust operation. */
export const ManualPremiumItemDeliverySchema = z
  .object({
    requestId: z.string().uuid(),
    playerId: z.string().uuid(),
    itemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(1000),
    reason: z.string().trim().min(8).max(400),
  })
  .strict();

export type ManualPremiumItemDelivery = z.infer<typeof ManualPremiumItemDeliverySchema>;
