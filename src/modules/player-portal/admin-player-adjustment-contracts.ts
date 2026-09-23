import { z } from "zod";

const uuid = z.string().uuid();
const signedDelta = z.string().regex(/^-?[1-9][0-9]*$/);
const reason = z.string().trim().min(1).max(2000);

export const AdminPlayerAdjustmentRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      requestId: uuid,
      kind: z.literal("INVENTORY"),
      itemId: uuid,
      delta: signedDelta,
      reason,
    })
    .strict(),
  z
    .object({
      requestId: uuid,
      kind: z.literal("WALLET"),
      currencyId: uuid,
      delta: signedDelta,
      reason,
    })
    .strict(),
  z
    .object({
      requestId: uuid,
      kind: z.literal("PROGRESSION"),
      delta: signedDelta,
      reason,
    })
    .strict(),
]);

export type AdminPlayerAdjustmentRequest = z.infer<
  typeof AdminPlayerAdjustmentRequestSchema
>;
