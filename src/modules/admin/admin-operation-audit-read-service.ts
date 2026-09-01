import {
  type AdminOperationAuditEvidence,
  type AdminOperationAuditReadRepository,
  type AdminOperationAuditTimelineView,
  type AdminOperationAuditView,
} from "./admin-operation-audit-read-contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";

interface AdminOperationAuditReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<{ operationId: string }>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface AdminOperationAuditReadRequest {
  readonly principalId: string;
  readonly correlationId: string;
  readonly operationId: string;
}

function projectTimeline(evidence: AdminOperationAuditEvidence): readonly AdminOperationAuditTimelineView[] {
  return evidence.timeline.map((event) => ({
    ...event,
    occurredAt: event.occurredAt.toISOString(),
  }));
}

export class AdminOperationAuditReadService {
  public constructor(
    private readonly authorizer: AdminOperationAuditReadAuthorizer,
    private readonly repository: AdminOperationAuditReadRepository,
  ) {}

  public async get(request: AdminOperationAuditReadRequest): Promise<AdminOperationAuditView> {
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "admin.operation.audit",
      input: { operationId: request.operationId },
      correlationId: request.correlationId,
    });

    const evidence = await this.repository.reconstruct(request.operationId);
    if (evidence === null) {
      throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
    }

    return {
      operation: {
        ...evidence.operation,
        createdAt: evidence.operation.createdAt.toISOString(),
        updatedAt: evidence.operation.updatedAt.toISOString(),
        appliedAt: evidence.operation.appliedAt?.toISOString() ?? null,
      },
      timeline: projectTimeline(evidence),
    };
  }
}
