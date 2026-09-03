import type { AdminOperationStatus, AdminRiskTier } from "./contracts.js";

export type AdminOperationAuditTimelineKind =
  | "PROPOSED"
  | "CONFIRMATION"
  | "APPROVAL"
  | "CHANGE"
  | "AUDIT";

export type AdminOperationAuditDecision = "APPROVED" | "REJECTED";

export interface AdminOperationAuditPolicyView {
  readonly version: number;
  readonly requiresReason: boolean;
  readonly requiresExpectedRevision: boolean;
  readonly requiresSimulation: boolean;
  readonly requiresConfirmation: boolean;
  readonly requiredApprovals: number;
}

export interface AdminOperationAuditOperationEvidence {
  readonly id: string;
  readonly principalId: string;
  readonly capabilityKey: string;
  readonly operationType: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly riskTier: AdminRiskTier;
  readonly status: AdminOperationStatus;
  readonly correlationId: string;
  readonly reasonRecorded: boolean;
  readonly expectedRevision: string | null;
  readonly revision: string;
  readonly policy: AdminOperationAuditPolicyView;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly appliedAt: Date | null;
}

export interface AdminOperationAuditTimelineEvidence {
  readonly kind: AdminOperationAuditTimelineKind;
  readonly occurredAt: Date;
  readonly actorPrincipalId: string | null;
  readonly action: string;
  readonly decision: AdminOperationAuditDecision | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly eventId: string;
}

export interface AdminOperationAuditEvidence {
  readonly operation: AdminOperationAuditOperationEvidence;
  readonly timeline: readonly AdminOperationAuditTimelineEvidence[];
}

export interface AdminOperationAuditOperationView
  extends Omit<AdminOperationAuditOperationEvidence, "createdAt" | "updatedAt" | "appliedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
}

export interface AdminOperationAuditTimelineView
  extends Omit<AdminOperationAuditTimelineEvidence, "occurredAt"> {
  readonly occurredAt: string;
}

export interface AdminOperationAuditView {
  readonly operation: AdminOperationAuditOperationView;
  readonly timeline: readonly AdminOperationAuditTimelineView[];
}

export interface AdminOperationAuditReadRepository {
  reconstruct(operationId: string): Promise<AdminOperationAuditEvidence | null>;
}
