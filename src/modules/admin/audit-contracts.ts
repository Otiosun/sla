import type { AdminOperationStatus, AdminRiskTier } from "./contracts.js";

export interface AdminAuditEntry {
  readonly operationId: string;
  readonly operationType: string;
  readonly actorDisplayName: string;
  readonly targetType: string;
  readonly riskTier: AdminRiskTier;
  readonly status: AdminOperationStatus;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}
