import { z } from "zod";
import {
  AdminInventoryAdjustInputSchema,
  AdminTrainerProgressAdjustInputSchema,
  AdminWalletAdjustInputSchema,
} from "./domain-contracts.js";

const uuidSchema = z.string().uuid();

export const AdminBatchSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("PLAYER_IDS"), playerIds: z.array(uuidSchema).min(1).max(1000) })
    .strict()
    .refine((value) => new Set(value.playerIds).size === value.playerIds.length, {
      message: "playerIds must be unique",
      path: ["playerIds"],
    }),
  z
    .object({
      kind: z.literal("PLAYER_FILTER"),
      status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
      originRegionId: uuidSchema.optional(),
      limit: z.number().int().min(1).max(1000).default(1000),
    })
    .strict()
    .refine((value) => value.status !== undefined || value.originRegionId !== undefined, {
      message: "PLAYER_FILTER requires status or originRegionId",
    }),
]);
export type AdminBatchSelector = z.infer<typeof AdminBatchSelectorSchema>;

const inventoryActionSchema = AdminInventoryAdjustInputSchema.omit({ playerId: true }).extend({
  kind: z.literal("INVENTORY_ADJUST"),
});
const walletActionSchema = AdminWalletAdjustInputSchema.omit({ playerId: true }).extend({
  kind: z.literal("WALLET_ADJUST"),
});
const progressionActionSchema = AdminTrainerProgressAdjustInputSchema.omit({ playerId: true }).extend({
  kind: z.literal("TRAINER_PROGRESSION_ADJUST"),
});

export const AdminBatchActionSchema = z.discriminatedUnion("kind", [
  inventoryActionSchema,
  walletActionSchema,
  progressionActionSchema,
]);
export type AdminBatchAction = z.infer<typeof AdminBatchActionSchema>;

export const AdminBatchPreviewInputSchema = z
  .object({
    selector: AdminBatchSelectorSchema,
    action: AdminBatchActionSchema,
    chunkSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminBatchPreviewInput = z.infer<typeof AdminBatchPreviewInputSchema>;

export const AdminBatchExecuteInputSchema = z.object({ batchId: uuidSchema }).strict();
export type AdminBatchExecuteInput = z.infer<typeof AdminBatchExecuteInputSchema>;

export type AdminBatchStatus = "PREVIEWED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_ERRORS";

export interface AdminBatchRecord extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly principalId: string;
  readonly previewAdminOperationId: string;
  readonly executeAdminOperationId: string | null;
  readonly childOperationType: string;
  readonly childCapabilityKey: string;
  readonly status: AdminBatchStatus;
  readonly selector: Readonly<Record<string, unknown>>;
  readonly sharedInput: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly targetCount: number;
  readonly checkpointOrdinal: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly report: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface AdminBatchTargetSnapshot {
  readonly ordinal: number;
  readonly playerId: string;
  readonly childInput: Readonly<Record<string, unknown>>;
  readonly childIdempotencyKey: string;
}

export interface AdminBatchTargetResult extends AdminBatchTargetSnapshot {
  readonly status: "PENDING" | "SUCCEEDED" | "FAILED";
  readonly childAdminOperationId: string | null;
  readonly attempts: number;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
}

export interface AdminBatchPreviewResult extends Readonly<Record<string, unknown>> {
  readonly batchId: string;
  readonly childOperationType: string;
  readonly targetCount: number;
  readonly estimatedChunks: number;
  readonly chunkSize: number;
  readonly revision: string;
  readonly sampleTargetIds: readonly string[];
}

export interface AdminBatchExecutionResult extends Readonly<Record<string, unknown>> {
  readonly batchId: string;
  readonly status: "COMPLETED" | "COMPLETED_WITH_ERRORS";
  readonly targetCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly checkpointOrdinal: number;
  readonly revision: string;
  readonly replayed: boolean;
  readonly failures: readonly Readonly<Record<string, unknown>>[];
}

export function batchActionOperation(action: AdminBatchAction): {
  readonly operationType: "inventory.adjust" | "wallet.adjust" | "progression.trainer.adjust";
  readonly capabilityKey: "inventory.adjust" | "wallet.adjust" | "progression.adjust";
} {
  if (action.kind === "INVENTORY_ADJUST") {
    return { operationType: "inventory.adjust", capabilityKey: "inventory.adjust" };
  }
  if (action.kind === "WALLET_ADJUST") {
    return { operationType: "wallet.adjust", capabilityKey: "wallet.adjust" };
  }
  return { operationType: "progression.trainer.adjust", capabilityKey: "progression.adjust" };
}

export function batchChildInput(
  action: AdminBatchAction,
  playerId: string,
): Readonly<Record<string, unknown>> {
  if (action.kind === "INVENTORY_ADJUST") {
    return { playerId, itemId: action.itemId, delta: action.delta };
  }
  if (action.kind === "WALLET_ADJUST") {
    return { playerId, currencyId: action.currencyId, delta: action.delta };
  }
  return { playerId, delta: action.delta };
}
