import type { AdminOperationRecord } from "./contracts.js";
import type { AdminCompensationInput } from "./compensation-contracts.js";

export interface CompleteAdminCompensationInput {
  readonly sourceOperation: AdminOperationRecord;
  readonly compensationOperation: AdminOperationRecord;
  readonly actorPrincipalId: string;
  readonly compensationKind: "INVERSE_DELTA_V1";
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly beforeData: Readonly<Record<string, unknown>>;
  readonly afterData: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface AdminCompensationCompletionPort {
  completeCompensation(input: CompleteAdminCompensationInput): Promise<AdminOperationRecord>;
}

export interface AdminCompensationOperationPort {
  applyCompensation(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminCompensationInput,
  ): Promise<AdminOperationRecord>;
}
