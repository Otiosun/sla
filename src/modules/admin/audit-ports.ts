import type { AdminAuditEntry } from "./audit-contracts.js";

export interface AdminAuditRepository {
  listRecent(limit: number): Promise<readonly AdminAuditEntry[]>;
}
