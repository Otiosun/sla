import { describe, expect, it, vi } from "vitest";
import { mapAdminHttpError } from "../../src/adapters/admin-api/http-error-mapper.js";
import { AdminRequestAuthenticator } from "../../src/adapters/admin-api/request-authenticator.js";
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
    const verify = vi.fn().mockResolvedValue(externalIdentity);
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

  it("fails closed before verification when the assertion is malformed", async () => {
    const verify = vi.fn();
    const resolve = vi.fn();
    const authenticator = new AdminRequestAuthenticator({ verify }, { resolve });

    await expect(authenticator.authenticate("short")).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("mapAdminHttpError", () => {
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
