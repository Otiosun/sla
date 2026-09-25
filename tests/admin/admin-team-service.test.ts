import { describe, expect, it, vi } from "vitest";
import { AdminTeamService } from "../../src/modules/admin/team-service.js";
import type { AdminTeamRepository } from "../../src/modules/admin/team-ports.js";

function repository(overrides: Partial<AdminTeamRepository> = {}): AdminTeamRepository {
  return {
    isOwner: vi.fn(async () => true),
    listPrincipals: vi.fn(async () => []),
    listCapabilityCatalog: vi.fn(async () => []),
    replaceCapabilities: vi.fn(async (input) => ({
      principalId: input.targetPrincipalId,
      displayName: "Staff",
      status: "ACTIVE" as const,
      owner: false,
      revision: (input.expectedRevision + 1n).toString(),
      capabilities: [...input.capabilities],
    })),
    ...overrides,
  };
}

describe("AdminTeamService", () => {
  it("allows protected owners to list the administrative team", async () => {
    const repo = repository({
      listPrincipals: vi.fn(async () => [
        {
          principalId: "00000000-0000-4000-8000-000000000001",
          displayName: "Dono",
          status: "ACTIVE" as const,
          owner: true,
          revision: "0",
          capabilities: ["central.view"],
        },
      ]),
      listCapabilityCatalog: vi.fn(async () => [{ key: "central.view", riskTier: 0 }]),
    });
    const service = new AdminTeamService(repo);

    await expect(service.list("00000000-0000-4000-8000-000000000001")).resolves.toEqual({
      principals: [expect.objectContaining({ displayName: "Dono", owner: true })],
      capabilityCatalog: [{ key: "central.view", riskTier: 0 }],
    });
  });

  it("rejects permission management from non-owners even if they are admins", async () => {
    const repo = repository({ isOwner: vi.fn(async () => false) });
    const service = new AdminTeamService(repo);

    await expect(
      service.replaceCapabilities(
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000020",
        {
          capabilities: ["central.view", "wallet.adjust"],
          reason: "delegação",
          expectedRevision: "0",
        },
      ),
    ).rejects.toMatchObject({ code: "ADMIN_AUTHORIZATION_DENIED" });
    expect(repo.replaceCapabilities).not.toHaveBeenCalled();
  });

  it("deduplicates selected powers before replacing the target effective set", async () => {
    const replaceCapabilities = vi.fn(async (input) => ({
      principalId: input.targetPrincipalId,
      displayName: "Staff",
      status: "ACTIVE" as const,
      owner: false,
      revision: (input.expectedRevision + 1n).toString(),
      capabilities: [...input.capabilities],
    }));
    const repo = repository({ replaceCapabilities });
    const service = new AdminTeamService(repo);

    await service.replaceCapabilities(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      {
        capabilities: ["wallet.adjust", "central.view", "wallet.adjust"],
        reason: "Economia do evento",
        expectedRevision: "4",
      },
    );

    expect(replaceCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: ["central.view", "wallet.adjust"],
        expectedRevision: 4n,
        reason: "Economia do evento",
      }),
    );
  });
});
