import { describe, expect, it, vi } from "vitest";
import {
  AdminAccessSessionGuard,
  type AdminAccessSessionRepository,
} from "../../src/adapters/admin-api/access-session-guard.js";
import {
  AdminUnauthenticatedError,
  type AuthenticatedAdminRequestContext,
} from "../../src/adapters/admin-api/request-authenticator.js";
import { ManualClock } from "../../src/platform/clock/index.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-31T16:00:00.000Z");

function context(overrides: Partial<AuthenticatedAdminRequestContext["accessSession"]> = {}) {
  return {
    principalId: PRINCIPAL_ID,
    environment: "staging" as const,
    identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
    displayEmail: "admin@example.com",
    accessSession: {
      tokenFingerprint: "a".repeat(64),
      issuedAt: new Date("2026-08-31T15:00:00.000Z"),
      notBefore: new Date("2026-08-31T15:00:00.000Z"),
      expiresAt: new Date("2026-08-31T17:00:00.000Z"),
      ...overrides,
    },
  } satisfies AuthenticatedAdminRequestContext;
}

function repository(decision: "ACTIVE" | "DENIED" = "ACTIVE") {
  const useSession = vi
    .fn<AdminAccessSessionRepository["useSession"]>()
    .mockResolvedValue(decision);
  return { useSession };
}

describe("AdminAccessSessionGuard", () => {
  it("admits a verified session and clamps idle expiry to the Access absolute expiry", async () => {
    const repo = repository();
    const guard = new AdminAccessSessionGuard(repo, new ManualClock(NOW), 7_200_000);
    const authenticated = context();

    await expect(guard.authorize(authenticated)).resolves.toBe(authenticated);
    expect(repo.useSession).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      tokenFingerprint: "a".repeat(64),
      accessIssuedAt: new Date("2026-08-31T15:00:00.000Z"),
      accessNotBefore: new Date("2026-08-31T15:00:00.000Z"),
      accessExpiresAt: new Date("2026-08-31T17:00:00.000Z"),
      observedAt: NOW,
      idleExpiresAt: new Date("2026-08-31T17:00:00.000Z"),
    });
  });

  it("fails closed when persistence denies a revoked or idle-expired fingerprint", async () => {
    const repo = repository("DENIED");
    const guard = new AdminAccessSessionGuard(repo, new ManualClock(NOW), 1_800_000);

    await expect(guard.authorize(context())).rejects.toBeInstanceOf(AdminUnauthenticatedError);
  });

  it("rejects an absolutely expired Access assertion before touching session persistence", async () => {
    const repo = repository();
    const guard = new AdminAccessSessionGuard(repo, new ManualClock(NOW), 1_800_000);

    await expect(
      guard.authorize(context({ expiresAt: new Date("2026-08-31T16:00:00.000Z") })),
    ).rejects.toBeInstanceOf(AdminUnauthenticatedError);
    expect(repo.useSession).not.toHaveBeenCalled();
  });

  it("rejects invalid idle timeout policy at construction", () => {
    const repo = repository();
    expect(() => new AdminAccessSessionGuard(repo, new ManualClock(NOW), 0)).toThrow(
      "Admin access session idle timeout must be a positive safe integer",
    );
  });
});
