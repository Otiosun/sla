import { describe, expect, it, vi } from "vitest";
import { createPublicVerificationServer } from "../../src/adapters/public-api/fastify-server.js";
import { loadPublicVerificationRuntimeConfig } from "../../src/runtime/public-verification-runtime-config.js";

const PUBLIC_ID = "tcv_7Qm2Yp9Kx4Nw8Vr6Hs3Df1Za";
const CANONICAL_KEY = Buffer.alloc(32, 7).toString("base64");
const CANONICAL_PEPPER = Buffer.alloc(32, 11).toString("base64");

function verificationDependencies(consume: ReturnType<typeof vi.fn>) {
  return {
    verificationService: {
      verify: vi.fn().mockResolvedValue({ status: "INVALID" as const }),
    },
    rateLimiter: { consume },
  };
}

describe("public verification trusted-proxy boundary", () => {
  it("uses forwarded client IP only when the immediate peer is explicitly trusted", async () => {
    const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 1 });
    const server = createPublicVerificationServer(verificationDependencies(consume), {
      trustedProxyCidrs: ["127.0.0.1/32"],
    });

    await server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    expect(consume).toHaveBeenLastCalledWith({
      publicId: PUBLIC_ID,
      remoteAddress: "203.0.113.42",
    });

    await server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
      remoteAddress: "198.51.100.10",
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(consume).toHaveBeenLastCalledWith({
      publicId: PUBLIC_ID,
      remoteAddress: "198.51.100.10",
    });

    await server.close();
  });

  it("defaults to direct-peer identity and refuses trust-all proxy configuration", () => {
    const direct = loadPublicVerificationRuntimeConfig({
      PUBLIC_VERIFICATION_SIGNING_KEY_BASE64: CANONICAL_KEY,
      PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: CANONICAL_PEPPER,
    });
    expect(direct.trustedProxyCidrs).toEqual([]);

    expect(() =>
      loadPublicVerificationRuntimeConfig({
        PUBLIC_VERIFICATION_SIGNING_KEY_BASE64: CANONICAL_KEY,
        PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: CANONICAL_PEPPER,
        PUBLIC_VERIFICATION_TRUSTED_PROXY_CIDRS: "0.0.0.0/0",
      }),
    ).toThrow(/trusted proxy/i);
    expect(() =>
      loadPublicVerificationRuntimeConfig({
        PUBLIC_VERIFICATION_SIGNING_KEY_BASE64: CANONICAL_KEY,
        PUBLIC_VERIFICATION_RATE_LIMIT_PEPPER_BASE64: CANONICAL_PEPPER,
        PUBLIC_VERIFICATION_TRUSTED_PROXY_CIDRS: "::/0",
      }),
    ).toThrow(/trusted proxy/i);
  });
});
