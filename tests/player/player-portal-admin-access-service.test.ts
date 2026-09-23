import { describe, expect, it, vi } from "vitest";
import { PlayerPortalAdminAccessService } from "../../src/modules/player-portal/admin-access-service.js";

const identity = {
  provider: "baileys",
  externalId: "5511999999999@s.whatsapp.net",
};

describe("PlayerPortalAdminAccessService", () => {
  it("returns null for a normal player with no active admin principal", async () => {
    const resolvePrincipal = vi.fn(async () => null);
    const getAuthorizationSnapshot = vi.fn();

    const service = new PlayerPortalAdminAccessService(
      { resolvePrincipal },
      { getAuthorizationSnapshot },
    );

    await expect(service.get(identity)).resolves.toBeNull();
    expect(getAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it("projects only capability and scope authorization for an active admin", async () => {
    const principalId = "11111111-1111-4111-8111-111111111111";
    const service = new PlayerPortalAdminAccessService(
      { resolvePrincipal: async () => ({ principalId }) },
      {
        getAuthorizationSnapshot: async () => ({
          principalId,
          status: "ACTIVE" as const,
          capabilities: [
            { key: "player.read", riskTier: 0 as const },
            { key: "pokemon.edit.basic", riskTier: 3 as const },
          ],
          scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        }),
      },
    );

    await expect(service.get(identity)).resolves.toEqual({
      capabilities: [
        { key: "player.read", riskTier: 0 },
        { key: "pokemon.edit.basic", riskTier: 3 },
      ],
      scopes: [{ scopeType: "GLOBAL", scopeId: null }],
    });
  });

  it("does not expose disabled principals through the Hub", async () => {
    const principalId = "11111111-1111-4111-8111-111111111111";
    const service = new PlayerPortalAdminAccessService(
      { resolvePrincipal: async () => ({ principalId }) },
      {
        getAuthorizationSnapshot: async () => ({
          principalId,
          status: "DISABLED" as const,
          capabilities: [{ key: "player.read", riskTier: 0 as const }],
          scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
        }),
      },
    );

    await expect(service.get(identity)).resolves.toBeNull();
  });
});
