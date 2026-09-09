import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { HubSessionTokenService } from "../../src/modules/player-portal/session-token-service.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};
const issuedAt = new Date("2026-09-09T12:00:00.000Z");
const signingKey = Buffer.alloc(32, 7);

function service(now = issuedAt, key = signingKey): HubSessionTokenService {
  return new HubSessionTokenService({
    signingKey: key,
    now: () => now,
  });
}

describe("HubSessionTokenService", () => {
  it("issues a signed 12-hour session and verifies its external identity", () => {
    const sessions = service();

    const issued = sessions.issue(identity);

    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.expiresAt.toISOString()).toBe("2026-09-10T00:00:00.000Z");

    const verified = sessions.verify(issued.value.token);
    expect(verified).toEqual({ ok: true, value: identity });
  });

  it("rejects a session whose signature was tampered with", () => {
    const sessions = service();
    const issued = sessions.issue(identity);
    if (!issued.ok) throw new Error("expected session issuance to succeed");
    const [payload, signature] = issued.value.token.split(".");
    if (!payload || !signature) throw new Error("expected signed session token");
    const replacement = signature.startsWith("A") ? "B" : "A";
    const tampered = `${payload}.${replacement}${signature.slice(1)}`;

    const result = sessions.verify(tampered);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Hub session unavailable",
      },
    });
  });

  it("rejects a session at its expiry boundary", () => {
    const issued = service().issue(identity);
    if (!issued.ok) throw new Error("expected session issuance to succeed");

    const result = service(new Date("2026-09-10T00:00:00.000Z")).verify(issued.value.token);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Hub session unavailable",
      },
    });
  });

  it("rejects a token signed by another key", () => {
    const issued = service().issue(identity);
    if (!issued.ok) throw new Error("expected session issuance to succeed");

    const result = service(issuedAt, Buffer.alloc(32, 8)).verify(issued.value.token);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed external identities before signing", () => {
    const result = service().issue({ provider: "Whats App", externalId: "" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
