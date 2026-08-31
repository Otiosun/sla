import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudflareAccessJwtVerifier } from "../../src/adapters/admin-api/cloudflare-access-verifier.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";

const TEAM_DOMAIN = "https://pokemon-rpg.cloudflareaccess.com";
const AUDIENCE = "control-center-audience";
const KID = "test-signing-key";
const NOW_MS = Date.parse("2026-08-30T00:00:00Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const exportedJwk = publicKey.export({ format: "jwk" });
const publicJwk = {
  ...exportedJwk,
  kid: KID,
  alg: "RS256",
  use: "sig",
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function tokenFor(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): string {
  const encodedHeader = encode(header);
  const encodedPayload = encode(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUDIENCE],
    email: "admin@example.com",
    exp: NOW_SECONDS + 600,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    iss: TEAM_DOMAIN,
    sub: "stable-access-subject",
    type: "app",
    ...overrides,
  };
}

function verifier() {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  return new CloudflareAccessJwtVerifier(
    {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      clockSkewSeconds: 30,
    },
    { fetchImpl, now: () => NOW_MS },
  );
}

describe("CloudflareAccessJwtVerifier", () => {
  it("accepts a correctly signed identity application token and preserves trusted session bounds", async () => {
    await expect(verifier().verify(tokenFor(validClaims()))).resolves.toEqual({
      identity: {
        provider: "cloudflare-access",
        issuer: TEAM_DOMAIN,
        subject: "stable-access-subject",
        email: "admin@example.com",
      },
      issuedAt: new Date((NOW_SECONDS - 60) * 1_000),
      notBefore: new Date((NOW_SECONDS - 60) * 1_000),
      expiresAt: new Date((NOW_SECONDS + 600) * 1_000),
    });
  });

  it("rejects a token issued for another Access application audience", async () => {
    await expect(
      verifier().verify(tokenFor(validClaims({ aud: ["different-application"] }))),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });

  it("rejects expired tokens", async () => {
    await expect(
      verifier().verify(tokenFor(validClaims({ exp: NOW_SECONDS - 31 }))),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });

  it("rejects payload tampering even when claims still look valid", async () => {
    const original = tokenFor(validClaims());
    const [header, _payload, signature] = original.split(".");
    const tamperedPayload = encode(validClaims({ sub: "attacker" }));

    await expect(
      verifier().verify(`${header}.${tamperedPayload}.${signature}`),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });

  it("rejects service-token style identities with an empty subject", async () => {
    await expect(verifier().verify(tokenFor(validClaims({ sub: "" })))).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
    });
  });

  it("rejects non-RS256 JWT headers", async () => {
    await expect(
      verifier().verify(tokenFor(validClaims(), { alg: "HS256", kid: KID, typ: "JWT" })),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });
  });
});
