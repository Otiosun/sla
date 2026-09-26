import { describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../../src/modules/admin/audit-service.js";
import type { AdminAuditRepository } from "../../src/modules/admin/audit-ports.js";

function repository(): AdminAuditRepository {
  return {
    listRecent: vi.fn(async () => [
      {
        operationId: "00000000-0000-4000-8000-000000000111",
        operationType: "wallet.adjust",
        actorDisplayName: "Admin",
        targetType: "PLAYER",
        riskTier: 2 as const,
        status: "APPLIED" as const,
        reason: "Correção de evento",
        createdAt: "2026-09-26T05:00:00.000Z",
        appliedAt: "2026-09-26T05:00:01.000Z",
      },
    ]),
  };
}

describe("AdminAuditService", () => {
  it("authorizes audit.read through the registry read boundary before listing history", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "ADMIN_OPERATION", id: null }));
    const repo = repository();
    const service = new AdminAuditService({ authorizeRead }, repo);

    await expect(service.list("00000000-0000-4000-8000-000000000001", 25)).resolves.toEqual([
      expect.objectContaining({
        operationType: "wallet.adjust",
        actorDisplayName: "Admin",
        status: "APPLIED",
      }),
    ]);

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: "00000000-0000-4000-8000-000000000001",
      operationType: "admin.operation.audit",
      input: { operationId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(repo.listRecent).toHaveBeenCalledWith(25);
  });

  it("does not touch the audit repository when authorization is denied", async () => {
    const denied = Object.assign(new Error("denied"), { code: "ADMIN_AUTHORIZATION_DENIED" });
    const authorizeRead = vi.fn(async () => {
      throw denied;
    });
    const repo = repository();
    const service = new AdminAuditService({ authorizeRead }, repo);

    await expect(service.list("00000000-0000-4000-8000-000000000002", 100)).rejects.toBe(denied);
    expect(repo.listRecent).not.toHaveBeenCalled();
  });

  it("bounds the requested history size", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "ADMIN_OPERATION", id: null }));
    const repo = repository();
    const service = new AdminAuditService({ authorizeRead }, repo);

    await service.list("00000000-0000-4000-8000-000000000001", 999);
    expect(repo.listRecent).toHaveBeenCalledWith(100);
  });
});
