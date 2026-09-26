import type { AdminAuditEntry } from "./audit-contracts.js";
import type { AdminAuditRepository } from "./audit-ports.js";
import type { AdminService } from "./service.js";

const AUDIT_AUTHORIZATION_SENTINEL = "00000000-0000-4000-8000-000000000000";

export class AdminAuditService {
  public constructor(
    private readonly admin: Pick<AdminService, "authorizeRead">,
    private readonly repository: AdminAuditRepository,
  ) {}

  public async list(principalId: string, rawLimit = 100): Promise<readonly AdminAuditEntry[]> {
    await this.admin.authorizeRead({
      principalId,
      operationType: "admin.operation.audit",
      input: { operationId: AUDIT_AUTHORIZATION_SENTINEL },
    });
    const limit = Math.min(100, Math.max(1, Math.trunc(rawLimit)));
    return this.repository.listRecent(limit);
  }
}
