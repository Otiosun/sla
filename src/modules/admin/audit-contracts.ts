import { z } from "zod";
import type {
  AdminAuthorizationMode,
  AdminOperationPolicy,
  AdminOperationStatus,
  AdminRiskTier,
} from "./contracts.js";

export const AdminOperationAuditInspectRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    operationId: z.string().uuid(),
  })
  .strict();
export type AdminOperationAuditInspectRequest = z.infer<
  typeof AdminOperationAuditInspectRequestSchema
>;

export interface AdminOperationAuditOperation {
  readonly id: string;
  readonly principalId: string;
  readonly capabilityKey: string;
  readonly operationType: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly riskTier: AdminRiskTier;
  readonly authorizationMode: AdminAuthorizationMode;
  readonly status: AdminOperationStatus;
  readonly reason: string | null;
  readonly expectedRevision: bigint | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  readonly policy: AdminOperationPolicy;
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly appliedAt: Date | null;
}

export interface AdminOperationAuditConfirmation {
  readonly principalId: string;
  readonly requestFingerprint: string;
  readonly createdAt: Date;
}

export interface AdminOperationAuditApproval {
  readonly principalId: string;
  readonly requestFingerprint: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly reason: string;
  readonly createdAt: Date;
}

export interface AdminOperationAuditChange {
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly beforeData: Readonly<Record<string, unknown>> | null;
  readonly afterData: Readonly<Record<string, unknown>> | null;
  readonly createdAt: Date;
}

export interface AdminOperationAuditEvent {
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly riskTier: number | null;
  readonly reason: string | null;
  readonly beforeData: Readonly<Record<string, unknown>> | null;
  readonly afterData: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly occurredAt: Date;
}

export type AdminOwnerEvidenceSource =
  | "POKEMON_ADMIN_CLAIM"
  | "ENCOUNTER_ADMIN_CLAIM"
  | "CATALOG_ADMIN_CLAIM"
  | "CATALOG_RELEASE_ADMIN_CLAIM"
  | "ADMIN_COMPENSATION"
  | "INVENTORY_LEDGER"
  | "WALLET_LEDGER"
  | "TRAINER_PROGRESS_LEDGER"
  | "BATTLE_EVENT";

export interface AdminOperationOwnerEvidence {
  readonly source: AdminOwnerEvidenceSource;
  readonly kind: string;
  readonly subjectId: string | null;
  readonly resourceId: string | null;
  readonly requestFingerprint: string | null;
  readonly correlationId: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface AdminOperationBatchEvidence {
  readonly batchId: string;
  readonly relation: "PREVIEW" | "EXECUTE";
  readonly status: string;
  readonly childOperationType: string;
  readonly childCapabilityKey: string;
  readonly targetCount: number;
  readonly checkpointOrdinal: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly report: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface AdminOperationAuditBundle {
  readonly operation: AdminOperationAuditOperation;
  readonly confirmations: readonly AdminOperationAuditConfirmation[];
  readonly approvals: readonly AdminOperationAuditApproval[];
  readonly changes: readonly AdminOperationAuditChange[];
  readonly auditEvents: readonly AdminOperationAuditEvent[];
  readonly ownerEvidence: readonly AdminOperationOwnerEvidence[];
  readonly batchEvidence: readonly AdminOperationBatchEvidence[];
}
