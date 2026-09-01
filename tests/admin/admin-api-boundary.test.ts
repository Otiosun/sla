import { describe, expect, it, vi } from "vitest";
import { mapAdminHttpError } from "../../src/adapters/admin-api/http-error-mapper.js";
import {
  AdminRequestAuthenticator,
  AdminUnauthenticatedError,
} from "../../src/adapters/admin-api/request-authenticator.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "x".repeat(64);

describe("AdminRequestAuthenticator", () => {
  it("chains verified external identity into internal principal resolution", async () => {
    const externalIdentity = {
      provider: "cloudflare-access" as const,
      issuer: "https://pokemon-rpg.cloudflareaccess.com",
      subject: "stable-subject",
      email: "admin@example.com",
    };
    const verify = vi.fn().mockResolvedValue({
      identity: externalIdentity,
      issuedAt: new Date("2026-08-31T12:00:00.000Z"),
      notBefore: new Date("2026-08-31T12:00:00.000Z"),
      expiresAt: new Date("2026-08-31T13:00:00.000Z"),
    });
    const resolve = vi.fn().mockResolvedValue({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
      displayEmail: "admin@example.com",
    });
    const authenticator = new AdminRequestAuthenticator({ verify }, { resolve });

    await expect(authenticator.authenticate(TOKEN)).resolves.toMatchObject({
      principalId: PRINCIPAL_ID,
      environment: "staging",
    });
    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(resolve).toHaveBeenCalledWith(externalIdentity);
  });

  it("fails as unauthenticated before verification when the assertion is malformed", async () => {
    const verify = vi.fn();
    const resolve = vi.fn();
    const authenticator = new AdminRequestAuthenticator({ verify }, { resolve });

    await expect(authenticator.authenticate("short")).rejects.toBeInstanceOf(
      AdminUnauthenticatedError,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("collapses verifier detail into an unauthenticated result", async () => {
    const authenticator = new AdminRequestAuthenticator(
      { verify: vi.fn().mockRejectedValue(new Error("JWKS internals")) },
      { resolve: vi.fn() },
    );

    await expect(authenticator.authenticate(TOKEN)).rejects.toBeInstanceOf(
      AdminUnauthenticatedError,
    );
  });
});

describe("mapAdminHttpError", () => {
  it("maps authentication failure to a generic 401", () => {
    const mapped = mapAdminHttpError(
      new AdminUnauthenticatedError("private verification detail"),
      "correlation-auth",
    );

    expect(mapped).toEqual({
      statusCode: 401,
      body: {
        error: {
          code: "ADMIN_UNAUTHENTICATED",
          message: "Administrative authentication required",
          correlationId: "correlation-auth",
        },
      },
    });
  });

  it("collapses principal lookup detail into one authorization denial", () => {
    const mapped = mapAdminHttpError(
      new AdminError(ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND, "sensitive lookup detail"),
      "correlation-1",
    );

    expect(mapped).toEqual({
      statusCode: 403,
      body: {
        error: {
          code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
          message: "Administrative access denied",
          correlationId: "correlation-1",
        },
      },
    });
  });

  it("never exposes unexpected exception messages", () => {
    const mapped = mapAdminHttpError(new Error("postgres password=secret"), "correlation-2");

    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.message).toBe("Administrative request failed");
    expect(JSON.stringify(mapped)).not.toContain("password=secret");
  });
});
