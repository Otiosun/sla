import {
  type AdminAuditEntry,
  type AdminOperationAuditBundle,
  AdminOperationAuditInspectRequestSchema,
} from "./audit-contracts.js";
import type { AdminAuditRepository, AdminOperationAuditRepository } from "./audit-ports.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminService } from "./service.js";

export class AdminOperationAuditService {
  public constructor(
    private readonly admin: AdminService,
    private readonly repository: AdminOperationAuditRepository,
  ) {}

  public async inspect(rawRequest: unknown): Promise<AdminOperationAuditBundle> {
    const parsed = AdminOperationAuditInspectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid admin audit request");
    }

    await this.admin.authorizeRead({
      principalId: parsed.data.principalId,
      operationType: "admin.operation.audit",
      input: { operationId: parsed.data.operationId },
    });

    const bundle = await this.repository.getOperationAudit(parsed.data.operationId);
    if (bundle === null) {
      throw new AdminError(ADMIN_ERROR_CODES.OPERATION_NOT_FOUND, "Admin operation not found");
    }
    return bundle;
  }
}

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
