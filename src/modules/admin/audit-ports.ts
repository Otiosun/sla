import type { AdminAuditEntry, AdminOperationAuditBundle } from "./audit-contracts.js";

export interface AdminOperationAuditRepository {
  getOperationAudit(operationId: string): Promise<AdminOperationAuditBundle | null>;
}

export interface AdminAuditRepository {
  listRecent(limit: number): Promise<readonly AdminAuditEntry[]>;
}
