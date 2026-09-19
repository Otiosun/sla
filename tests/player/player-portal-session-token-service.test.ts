import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { HubSessionTokenService } from "../../src/modules/player-portal/session-token-service.js";

const identity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999999@s.whatsapp.net",
};
const issuedAt = new Date("2026-09-18T12:00:00.000Z");
const signingKey = Buffer.alloc(32, 7);

function service(now = issuedAt, key = signingKey): HubSessionTokenService {
  return new HubSessionTokenService({ signingKey: key, now: () => now });
}

describe("HubSessionTokenService", () => {
  it("issues and verifies a signed twelve-hour session", () => {
    const issued = service().issue(identity);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.expiresAt.toISOString()).toBe("2026-09-19T00:00:00.000Z");
    expect(service().verify(issued.value.token)).toEqual({ ok: true, value: identity });
  });

  it("rejects tampering and expiry", () => {
    const issued = service().issue(identity);
    if (!issued.ok) throw new Error("expected session");
    const [payload, signature] = issued.value.token.split(".");
    if (!payload || !signature) throw new Error("expected signed token");

    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    expect(service().verify(tampered).ok).toBe(false);
    expect(service(new Date("2026-09-19T00:00:00.000Z")).verify(issued.value.token).ok).toBe(false);
  });
});
