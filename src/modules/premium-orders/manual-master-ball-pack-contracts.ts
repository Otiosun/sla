import { z } from "zod";

/**
 * The commercial product MASTER promises one Master Ball per unit.
 * Unlike generic admin inventory.adjust, the client never chooses an item ID.
 */
export const ManualMasterBallPackSchema = z.object({
  requestId: z.string().uuid(),
  playerId: z.string().uuid(),
  sku: z.literal("MASTER"),
  quantity: z.number().int().min(1).max(20),
  reason: z.string().trim().min(8).max(400),
}).strict();

export const MASTER_BALL_ITEM_SLUG = "master-ball";
