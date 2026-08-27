import { z } from "zod";
import { PlayerStatusSchema } from "./player360-contracts.js";

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
  }, "batch delta must fit PostgreSQL bigint and be non-zero");

export const AdminBatchSelectorSchema = z
  .object({
    status: PlayerStatusSchema.optional(),
    trainerNamePrefix: z.string().trim().min(1).max(80).optional(),
    originRegionId: uuidSchema.optional(),
    areaId: uuidSchema.optional(),
  })
  .strict();
export type AdminBatchSelector = z.infer<typeof AdminBatchSelectorSchema>;

const WalletAdjustBatchMutationSchema = z
  .object({
    kind: z.literal("WALLET_ADJUST"),
    currencyId: uuidSchema,
    delta: signedDeltaSchema,
  })
  .strict();

const InventoryAdjustBatchMutationSchema = z
  .object({
    kind: z.literal("INVENTORY_ADJUST"),
    itemId: uuidSchema,
    delta: signedDeltaSchema,
  })
  .strict();

export const AdminBatchMutationSchema = z.discriminatedUnion("kind", [
  WalletAdjustBatchMutationSchema,
  InventoryAdjustBatchMutationSchema,
]);
export type AdminBatchMutation = z.infer<typeof AdminBatchMutationSchema>;

export const AdminBatchPreviewRequestSchema = z
  .object({
    principalId: uuidSchema,
    selector: AdminBatchSelectorSchema,
    mutation: AdminBatchMutationSchema,
    reason: z.string().trim().min(1).max(512),
    idempotencyKey: z.string().trim().min(8).max(128),
    correlationId: uuidSchema,
    chunkSize: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type AdminBatchPreviewRequest = z.infer<typeof AdminBatchPreviewRequestSchema>;

export const AdminBatchInspectRequestSchema = z
  .object({ principalId: uuidSchema, batchId: uuidSchema })
  .strict();
export type AdminBatchInspectRequest = z.infer<typeof AdminBatchInspectRequestSchema>;

export const AdminBatchExecuteInputSchema = z.object({ batchId: uuidSchema }).strict();
export type AdminBatchExecuteInput = z.infer<typeof AdminBatchExecuteInputSchema>;

export const AdminBatchStatusSchema = z.enum([
  "PREVIEWED",
  "READY",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
]);
export type AdminBatchStatus = z.infer<typeof AdminBatchStatusSchema>;

export const AdminBatchTargetStatusSchema = z.enum([
  "PENDING",
  "CLAIMED",
  "APPLIED",
  "SKIPPED",
  "FAILED",
]);
export type AdminBatchTargetStatus = z.infer<typeof AdminBatchTargetStatusSchema>;

export interface AdminBatchDryRunSummary {
  readonly total: number;
  readonly ready: number;
  readonly expectedSkipped: number;
}

export interface AdminBatchSampleItem {
  readonly playerId: string;
  readonly playerRevision: string;
  readonly resourceRevision: string | null;
  readonly dryRunOk: boolean;
  readonly before: string;
  readonly after: string | null;
  readonly expectedErrorCode: string | null;
}

export interface AdminBatchExecutionReport {
  readonly total: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pending: number;
  readonly claimed: number;
  readonly checkpointSeq: number;
}

export interface AdminBatchView {
  readonly id: string;
  readonly principalId: string;
  readonly status: AdminBatchStatus;
  readonly executionRiskTier: 3 | 4;
  readonly selector: AdminBatchSelector;
  readonly mutation: AdminBatchMutation;
  readonly reason: string;
  readonly correlationId: string;
  readonly targetCount: number;
  readonly sample: readonly AdminBatchSampleItem[];
  readonly dryRunSummary: AdminBatchDryRunSummary;
  readonly chunkSize: number;
  readonly checkpointSeq: number;
  readonly authorizationOperationId: string | null;
  readonly authorizationOperationStatus: string | null;
  readonly report: AdminBatchExecutionReport | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface AdminBatchTargetView {
  readonly id: string;
  readonly batchId: string;
  readonly sequenceNo: number;
  readonly playerId: string;
  readonly playerRevision: string;
  readonly resourceRevision: string | null;
  readonly idempotencyKey: string;
  readonly dryRunOk: boolean;
  readonly dryRun: Readonly<Record<string, unknown>>;
  readonly status: AdminBatchTargetStatus;
  readonly attemptCount: number;
}

export interface AdminBatchCurrentTargetState {
  readonly playerRevision: string | null;
  readonly resourceRevision: string | null;
}

export interface AdminBatchProcessResult {
  readonly batchId: string;
  readonly processed: number;
  readonly report: AdminBatchExecutionReport;
  readonly status: AdminBatchStatus;
}
