import { describe, expect, it, vi } from "vitest";
import {
  LocalDevAdminRequestAuthenticator,
  LocalDevAdminSessionGuard,
} from "../../src/adapters/admin-api/local-dev-authenticator.js";
import { AdminUnauthenticatedError } from "../../src/adapters/admin-api/request-authenticator.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";

function authorization(status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  return {
    getAuthorizationSnapshot: vi.fn(async (principalId: string) => ({
      principalId,
      status,
      capabilities: [{ key: "player.read", riskTier: 0 as const }],
      scopes: [{ scopeType: "GLOBAL" as const, scopeId: null }],
    })),
  };
}

describe("LocalDevAdminRequestAuthenticator", () => {
  it("resolves only the configured ACTIVE PostgreSQL principal into trusted development context", async () => {
    const reader = authorization();
    const authenticator = new LocalDevAdminRequestAuthenticator(PRINCIPAL_ID, reader);

    const context = await authenticator.authenticate(undefined);

    expect(reader.getAuthorizationSnapshot).toHaveBeenCalledWith(PRINCIPAL_ID);
    expect(context).toMatchObject({
      principalId: PRINCIPAL_ID,
      environment: "development",
      identityRef: `local-development:${PRINCIPAL_ID}`,
      displayEmail: null,
    });
    expect(context.accessSession.tokenFingerprint).toMatch(/^local-dev:/);
  });

  it("fails closed when the configured principal does not exist", async () => {
    const reader = {
      getAuthorizationSnapshot: vi.fn(async () => null),
    };
    const authenticator = new LocalDevAdminRequestAuthenticator(PRINCIPAL_ID, reader);

    await expect(authenticator.authenticate(undefined)).rejects.toBeInstanceOf(
      AdminUnauthenticatedError,
    );
  });

  it("fails closed when the configured principal is disabled", async () => {
    const authenticator = new LocalDevAdminRequestAuthenticator(
      PRINCIPAL_ID,
      authorization("DISABLED"),
    );

    await expect(authenticator.authenticate(undefined)).rejects.toBeInstanceOf(
      AdminUnauthenticatedError,
    );
  });

  it("rejects a Cloudflare assertion in local mode instead of mixing trust boundaries", async () => {
    const authenticator = new LocalDevAdminRequestAuthenticator(PRINCIPAL_ID, authorization());

    await expect(authenticator.authenticate("not-used-in-local-mode")).rejects.toBeInstanceOf(
      AdminUnauthenticatedError,
    );
  });
});

describe("LocalDevAdminSessionGuard", () => {
  it("authorizes only the configured local development identity without durable Access writes", async () => {
    const authenticator = new LocalDevAdminRequestAuthenticator(PRINCIPAL_ID, authorization());
    const context = await authenticator.authenticate(undefined);
    const guard = new LocalDevAdminSessionGuard(PRINCIPAL_ID);

    await expect(guard.authorize(context)).resolves.toBe(context);
  });

  it("fails closed for a mismatched principal or non-local identity", async () => {
    const guard = new LocalDevAdminSessionGuard(PRINCIPAL_ID);
    const now = new Date();
    const impostor = {
      principalId: "22222222-2222-4222-8222-222222222222",
      environment: "development" as const,
      identityRef: "local-development:22222222-2222-4222-8222-222222222222",
      displayEmail: null,
      accessSession: {
        tokenFingerprint: "local-dev:impostor",
        issuedAt: now,
        notBefore: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
    };

    await expect(guard.authorize(impostor)).rejects.toBeInstanceOf(AdminUnauthenticatedError);
  });
});
