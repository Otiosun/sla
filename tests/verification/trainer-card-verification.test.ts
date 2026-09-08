import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Ed25519TrainerCardSigner,
  Ed25519TrainerCardVerifier,
  type TrainerCardPublicSnapshot,
  TrainerCardVerificationService,
} from "../../src/modules/verification/trainer-card-verification.js";
import { createPublicVerificationServer } from "../../src/adapters/public-api/fastify-server.js";

const PUBLIC_ID = "tcv_7Qm2Yp9Kx4Nw8Vr6Hs3Df1Za";
const KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "der", type: "pkcs8" },
  publicKeyEncoding: { format: "der", type: "spki" },
});
const SIGNER = new Ed25519TrainerCardSigner(KEY_PAIR.privateKey);
const VERIFIER = new Ed25519TrainerCardVerifier(KEY_PAIR.publicKey);
const SNAPSHOT: TrainerCardPublicSnapshot = {
  version: 1,
  trainerName: "Red",
  trainerTitle: "Treinador de Kanto",
  originRegion: "Kanto",
  currentLocation: "Route 1",
  leadPokemon: { dex: 25, nickname: "Pikachu" },
  earnedBadgeKeys: ["boulder", "cascade"],
  issuedAt: "2026-09-07T22:00:00.000Z",
};

describe("trainer-card verification cryptographic boundary", () => {
  it("detects any change to the immutable public snapshot", () => {
    const signature = SIGNER.sign(SNAPSHOT);

    expect(VERIFIER.verify(SNAPSHOT, signature)).toBe(true);
    expect(VERIFIER.verify({ ...SNAPSHOT, trainerName: "Blue" }, signature)).toBe(false);
    expect(VERIFIER.verify({ ...SNAPSHOT, currentLocation: "Viridian City" }, signature)).toBe(
      false,
    );
  });

  it("keeps personal profile and internal identity fields outside the signed public projection", () => {
    const serialized = JSON.stringify(SNAPSHOT);

    expect(serialized).not.toContain("playerId");
    expect(serialized).not.toContain("whatsapp");
    expect(serialized).not.toContain("externalId");
    expect(serialized).not.toContain("age");
    expect(serialized).not.toContain("height");
    expect(serialized).not.toContain("appearance");
    expect(serialized).not.toContain("bio");
  });
});

describe("TrainerCardVerificationService", () => {
  it("returns a signed ACTIVE record as VALID with only its public snapshot", async () => {
    const signature = SIGNER.sign(SNAPSHOT);
    const repository = {
      findByPublicId: vi.fn().mockResolvedValue({
        publicId: PUBLIC_ID,
        status: "ACTIVE" as const,
        snapshot: SNAPSHOT,
        signature,
        revokedAt: null,
      }),
    };
    const service = new TrainerCardVerificationService(repository, VERIFIER);

    await expect(service.verify(PUBLIC_ID)).resolves.toEqual({
      status: "VALID",
      publicId: PUBLIC_ID,
      snapshot: SNAPSHOT,
    });
  });

  it("returns REVOKED without releasing the old snapshot", async () => {
    const repository = {
      findByPublicId: vi.fn().mockResolvedValue({
        publicId: PUBLIC_ID,
        status: "REVOKED" as const,
        snapshot: SNAPSHOT,
        signature: SIGNER.sign(SNAPSHOT),
        revokedAt: new Date("2026-09-07T23:00:00.000Z"),
      }),
    };
    const service = new TrainerCardVerificationService(repository, VERIFIER);

    await expect(service.verify(PUBLIC_ID)).resolves.toEqual({
      status: "REVOKED",
      publicId: PUBLIC_ID,
    });
  });

  it("collapses missing records and bad signatures into the same INVALID response", async () => {
    const missing = new TrainerCardVerificationService(
      { findByPublicId: vi.fn().mockResolvedValue(null) },
      VERIFIER,
    );
    const tampered = new TrainerCardVerificationService(
      {
        findByPublicId: vi.fn().mockResolvedValue({
          publicId: PUBLIC_ID,
          status: "ACTIVE" as const,
          snapshot: { ...SNAPSHOT, trainerName: "Mallory" },
          signature: SIGNER.sign(SNAPSHOT),
          revokedAt: null,
        }),
      },
      VERIFIER,
    );

    await expect(missing.verify(PUBLIC_ID)).resolves.toEqual({ status: "INVALID" });
    await expect(tampered.verify(PUBLIC_ID)).resolves.toEqual({ status: "INVALID" });
  });
});

describe("public trainer-card verification HTTP boundary", () => {
  it("exposes only a rate-limited GET verification route and no public mutation", async () => {
    const verify = vi.fn().mockResolvedValue({ status: "INVALID" as const });
    const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    const server = createPublicVerificationServer({
      verificationService: { verify },
      rateLimiter: { consume },
    });

    const response = await server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ status: "INVALID" });
    expect(consume).toHaveBeenCalledOnce();

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const mutation = await server.inject({
        method,
        url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
      });
      expect(mutation.statusCode).toBe(404);
    }

    await server.close();
  });

  it("fails closed with 429 before verification when the public bucket is exhausted", async () => {
    const verify = vi.fn();
    const server = createPublicVerificationServer({
      verificationService: { verify },
      rateLimiter: {
        consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 17 }),
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.json()).toEqual({ error: { code: "PUBLIC_RATE_LIMITED" } });
    expect(verify).not.toHaveBeenCalled();

    await server.close();
  });

  it("redacts limiter failures instead of exposing infrastructure detail", async () => {
    const verify = vi.fn();
    const server = createPublicVerificationServer({
      verificationService: { verify },
      rateLimiter: {
        consume: vi.fn().mockRejectedValue(new Error("postgres password=sensitive-value")),
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/public/v1/trainer-cards/${PUBLIC_ID}/verify`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "PUBLIC_VERIFICATION_FAILED" } });
    expect(response.body).not.toContain("postgres");
    expect(response.body).not.toContain("sensitive-value");
    expect(verify).not.toHaveBeenCalled();

    await server.close();
  });
});
