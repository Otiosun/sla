import { z } from "zod";
import type { CorrelationId, PlayerId } from "../../shared-kernel/ids.js";
import type { ScopedIdempotencyKey } from "../../shared-kernel/idempotency.js";

const operationTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const EconomyActorTypeSchema = z.enum(["SYSTEM", "PLAYER", "ADMIN"]);
export type EconomyActorType = z.infer<typeof EconomyActorTypeSchema>;

export const EconomyMutationMetadataInputSchema = z
  .object({
    sourceType: operationTokenSchema,
    sourceId: z.string().trim().min(1).max(255),
    reason: z.string().trim().min(1).max(512),
    actorType: EconomyActorTypeSchema,
    actorId: z.string().uuid().nullable(),
    correlationId: z.string().uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType === "SYSTEM" && value.actorId !== null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "SYSTEM mutations must not carry an actorId",
      });
    }
    if (value.actorType !== "SYSTEM" && value.actorId === null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: `${value.actorType} mutations require actorId`,
      });
    }
  });
export type EconomyMutationMetadataInput = z.infer<typeof EconomyMutationMetadataInputSchema>;

export interface EconomyMutationMetadata {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: EconomyActorType;
  readonly actorId: string | null;
  readonly correlationId: CorrelationId;
  readonly idempotency: ScopedIdempotencyKey;
}

export interface InventoryLedgerRecord {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly itemId: string;
  readonly delta: bigint;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface WalletLedgerRecord {
  readonly id: string;
  readonly playerId: PlayerId;
  readonly currencyId: string;
  readonly delta: bigint;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface InventoryMutationResult {
  readonly playerId: PlayerId;
  readonly itemId: string;
  readonly delta: bigint;
  readonly quantity: bigint;
  readonly ledgerId: string;
  readonly replayed: boolean;
}

export interface WalletMutationResult {
  readonly playerId: PlayerId;
  readonly currencyId: string;
  readonly delta: bigint;
  readonly amount: bigint;
  readonly ledgerId: string;
  readonly replayed: boolean;
}

export interface PurchaseOffer {
  readonly id: string;
  readonly contentReleaseId: string;
  readonly offerKey: string;
  readonly itemId: string;
  readonly currencyId: string;
  readonly itemQuantity: bigint;
  readonly priceAmount: bigint;
  readonly active: boolean;
}

export interface PurchaseResult {
  readonly playerId: PlayerId;
  readonly contentReleaseId: string;
  readonly offerKey: string;
  readonly itemId: string;
  readonly itemQuantity: bigint;
  readonly inventoryQuantity: bigint;
  readonly currencyId: string;
  readonly priceAmount: bigint;
  readonly walletAmount: bigint;
  readonly replayed: boolean;
}
