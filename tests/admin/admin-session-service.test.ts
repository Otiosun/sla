import { describe, expect, it } from "vitest";
import { AdminSessionService } from "../../src/adapters/admin-api/session-service.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";

function identity() {
  return {
    principalId: PRINCIPAL_ID,
    environment: "staging" as const,
    identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
    displayEmail: "admin@example.com",
  };
}

describe("AdminSessionService", () => {
  it("projects roles, capabilities and scopes from backend state", async () => {
    const service = new AdminSessionService(
      {
        getAuthorizationSnapshot: async () => ({
          principalId: PRINCIPAL_ID,
          status: "ACTIVE",
          capabilities: [
            { key: "player.read", riskTier: 0 },
            { key: "player.read_sensitive", riskTier: 0 },
          ],
          scopes: [{ scopeType: "GLOBAL", scopeId: null }],
        }),
      },
      {
        listRoleSlugs: async () => ["SUPPORT", "OWNER_SECURITY_ADMIN"],
      },
    );

    await expect(service.getSession(identity())).resolves.toEqual({
      principalId: PRINCIPAL_ID,
      roles: ["OWNER_SECURITY_ADMIN", "SUPPORT"],
      capabilities: [
        { key: "player.read", riskTier: 0 },
        { key: "player.read_sensitive", riskTier: 0 },
      ],
      scopes: [{ scopeType: "GLOBAL", scopeId: null }],
      environment: "staging",
    });
  });

  it("fails closed if the canonical authorization snapshot is disabled", async () => {
    const service = new AdminSessionService(
      {
        getAuthorizationSnapshot: async () => ({
          principalId: PRINCIPAL_ID,
          status: "DISABLED",
          capabilities: [],
          scopes: [],
        }),
      },
      { listRoleSlugs: async () => ["OWNER_SECURITY_ADMIN"] },
    );

    await expect(service.getSession(identity())).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      message: "Administrative access denied",
    });
  });

  it("fails closed if the principal disappears before session projection", async () => {
    const service = new AdminSessionService(
      { getAuthorizationSnapshot: async () => null },
      { listRoleSlugs: async () => [] },
    );

    await expect(service.getSession(identity())).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
    });
  });
});
