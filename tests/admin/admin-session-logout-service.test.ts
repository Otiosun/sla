import { describe, expect, it, vi } from "vitest";
import {
  AdminSessionLogoutService,
  type AdminAccessSessionRevoker,
} from "../../src/adapters/admin-api/session-logout-service.js";
import { AdminUnauthenticatedError } from "../../src/adapters/admin-api/request-authenticator.js";
import { ManualClock } from "../../src/platform/clock/index.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-31T18:00:00.000Z");
const context = {
  principalId: PRINCIPAL_ID,
  environment: "staging" as const,
  identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
  displayEmail: "admin@example.com",
  accessSession: {
    tokenFingerprint: "a".repeat(64),
    issuedAt: new Date("2026-08-31T17:00:00.000Z"),
    notBefore: new Date("2026-08-31T17:00:00.000Z"),
    expiresAt: new Date("2026-08-31T19:00:00.000Z"),
  },
};

function revoker(result: boolean) {
  const revokeSession = vi.fn<AdminAccessSessionRevoker["revokeSession"]>().mockResolvedValue(result);
  return { revokeSession };
}

describe("AdminSessionLogoutService", () => {
  it("revokes only the fingerprint from the authenticated current session", async () => {
    const repository = revoker(true);
    const service = new AdminSessionLogoutService(repository, new ManualClock(NOW));

    await expect(service.logoutCurrent(context)).resolves.toEqual({
      logoutPath: "/cdn-cgi/access/logout",
    });
    expect(repository.revokeSession).toHaveBeenCalledWith({
      tokenFingerprint: "a".repeat(64),
      revokedAt: NOW,
      revokedByPrincipalId: PRINCIPAL_ID,
      reason: "SELF_LOGOUT",
    });
  });

  it("fails closed if the current session cannot be revoked", async () => {
    const service = new AdminSessionLogoutService(revoker(false), new ManualClock(NOW));
    await expect(service.logoutCurrent(context)).rejects.toBeInstanceOf(AdminUnauthenticatedError);
  });
});
