import type {
  AdminAuthorizationSnapshot,
  AdminOperationRecord,
  AdminOperationStatus,
  AdminRoleAssignInput,
  AdminSimulationResult,
  AdminTarget,
} from "./contracts.js";

export interface CreateAdminOperationInput {
  readonly id: string;
  readonly principalId: string;
  readonly capabilityKey: string;
  readonly operationType: string;
  readonly target: AdminTarget;
  readonly riskTier: 0 | 1 | 2 | 3 | 4;
  readonly status: AdminOperationStatus;
  readonly reason: string | null;
  readonly expectedRevision: bigint | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly policyVersion: number;
  readonly authorizationMode: "GLOBAL_ONLY" | "SUBJECT";
  readonly requiresReason: boolean;
  readonly requiresExpectedRevision: boolean;
  readonly requiresSimulation: boolean;
  readonly requiresConfirmation: boolean;
  readonly requiredApprovals: number;
}

export interface CompleteAdminOperationInput {
  readonly operation: AdminOperationRecord;
  readonly actorPrincipalId: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly beforeData: Readonly<Record<string, unknown>>;
  readonly afterData: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface AdminOperationRepository {
  getAuthorizationSnapshot(principalId: string): Promise<AdminAuthorizationSnapshot | null>;
  createOrReplayOperation(
    input: CreateAdminOperationInput,
  ): Promise<{ readonly operation: AdminOperationRecord; readonly replayed: boolean }>;
  getOperation(operationId: string): Promise<AdminOperationRecord | null>;
  saveSimulation(
    operationId: string,
    expectedOperationRevision: bigint,
    result: AdminSimulationResult,
    nextStatus: AdminOperationStatus,
  ): Promise<AdminOperationRecord>;
  recordConfirmation(
    operationId: string,
    principalId: string,
    requestFingerprint: string,
    nextStatus: AdminOperationStatus,
  ): Promise<AdminOperationRecord>;
  recordApproval(
    operationId: string,
    principalId: string,
    requestFingerprint: string,
    reason: string,
  ): Promise<AdminOperationRecord>;
  completeAppliedOperation(input: CompleteAdminOperationInput): Promise<AdminOperationRecord>;
}

export interface AdminRoleAssignmentPort {
  simulateRoleAssignment(input: AdminRoleAssignInput): Promise<AdminSimulationResult>;
  applyRoleAssignment(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminRoleAssignInput,
  ): Promise<AdminOperationRecord>;
}
