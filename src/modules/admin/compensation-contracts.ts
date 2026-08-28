import { z } from "zod";

export const AdminCompensationInputSchema = z
  .object({
    sourceOperationId: z.string().uuid(),
    playerId: z.string().uuid(),
  })
  .strict();
export type AdminCompensationInput = z.infer<typeof AdminCompensationInputSchema>;

export const COMPENSATABLE_ADMIN_OPERATION_TYPES = [
  "inventory.adjust",
  "wallet.adjust",
  "progression.trainer.adjust",
] as const;

export type CompensatableAdminOperationType =
  (typeof COMPENSATABLE_ADMIN_OPERATION_TYPES)[number];

export function isCompensatableAdminOperationType(
  value: string,
): value is CompensatableAdminOperationType {
  return (COMPENSATABLE_ADMIN_OPERATION_TYPES as readonly string[]).includes(value);
}
