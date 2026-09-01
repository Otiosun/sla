import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdminRequestAuthenticator } from "../../src/adapters/admin-api/request-authenticator.js";

const TOKEN = "verified-access-token-".padEnd(64, "x");
const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY = {
  provider: "cloudflare-access" as const,
  issuer: "https://pokemon-rpg.cloudflareaccess.com",
  subject: "stable-subject",
  email: "admin@example.com",
};
const ISSUED_AT = new Date("2026-08-31T12:00:00.000Z");
const NOT_BEFORE = new Date("2026-08-31T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-31T13:00:00.000Z");

function expectedFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

describe("AdminRequestAuthenticator verified session context", () => {
  it("derives a non-reversible token fingerprint only after verification and preserves provider bounds", async () => {
    const verify = vi.fn().mockResolvedValue({
      identity: IDENTITY,
      issuedAt: ISSUED_AT,
      notBefore: NOT_BEFORE,
      expiresAt: EXPIRES_AT,
    });
    const resolve = vi.fn().mockResolvedValue({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      identityRef: "cloudflare-access:pokemon-rpg.cloudflareaccess.com:stable-subject",
      displayEmail: "admin@example.com",
    });
    const authenticator = new AdminRequestAuthenticator({ verify }, { resolve });

    const result = await authenticator.authenticate(`  ${TOKEN}  `);

    expect(verify).toHaveBeenCalledWith(TOKEN);
    expect(resolve).toHaveBeenCalledWith(IDENTITY);
    expect(result).toMatchObject({
      principalId: PRINCIPAL_ID,
      environment: "staging",
      accessSession: {
        tokenFingerprint: expectedFingerprint(TOKEN),
        issuedAt: ISSUED_AT,
        notBefore: NOT_BEFORE,
        expiresAt: EXPIRES_AT,
      },
    });
    expect(result.accessSession.tokenFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("never fingerprints or resolves an assertion that fails cryptographic verification", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("invalid signature"));
    const resolve = vi.fn();
    const authenticator = new AdminRequestAuthenticator({ verify }, { resolve });

    await expect(authenticator.authenticate(TOKEN)).rejects.toThrow(
      "Administrative authentication failed",
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});
