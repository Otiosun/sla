import type { AdminOperationAuditBundle } from "./audit-contracts.js";

export interface AdminOperationAuditRepository {
  getOperationAudit(operationId: string): Promise<AdminOperationAuditBundle | null>;
}
