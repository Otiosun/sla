import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  generateTrainerCardPublicId,
  TrainerCardIssuanceService,
} from "../../src/modules/verification/trainer-card-issuance.js";
import {
  Ed25519TrainerCardSigner,
  Ed25519TrainerCardVerifier,
  type TrainerCardPublicSnapshot,
} from "../../src/modules/verification/trainer-card-verification.js";

const KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "der", type: "pkcs8" },
  publicKeyEncoding: { format: "der", type: "spki" },
});
const SNAPSHOT: TrainerCardPublicSnapshot = {
  version: 1,
  trainerName: "Red",
  trainerTitle: "Treinador de Kanto",
  originRegion: "Kanto",
  currentLocation: "Route 1",
  leadPokemon: { dex: 25, nickname: "Pikachu" },
  earnedBadgeKeys: ["boulder"],
  issuedAt: "2026-09-07T22:00:00.000Z",
};

describe("trainer card internal issuance", () => {
  it("generates opaque non-sequential public ids with the verification contract format", () => {
    const ids = new Set(Array.from({ length: 256 }, () => generateTrainerCardPublicId()));

    expect(ids.size).toBe(256);
    for (const publicId of ids) {
      expect(publicId).toMatch(/^tcv_[A-Za-z0-9]{24}$/);
    }
  });

  it("signs before persistence and retries only public-id collisions", async () => {
    const signer = new Ed25519TrainerCardSigner(KEY_PAIR.privateKey);
    const verifier = new Ed25519TrainerCardVerifier(KEY_PAIR.publicKey);
    const issue = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ids = ["tcv_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8", "tcv_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"];
    const generatePublicId = vi.fn(() => {
      const value = ids.shift();
      if (value === undefined) throw new Error("unexpected id generation");
      return value;
    });
    const service = new TrainerCardIssuanceService({ issue }, signer, generatePublicId);

    const issued = await service.issue(SNAPSHOT);

    expect(issued.publicId).toBe("tcv_Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2");
    expect(generatePublicId).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(2);
    for (const call of issue.mock.calls) {
      const record = call[0];
      expect(record.status).toBe("ACTIVE");
      expect(record.snapshot).toEqual(SNAPSHOT);
      expect(record.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
      expect(verifier.verify(record.snapshot, record.signature)).toBe(true);
    }
  });

  it("fails closed after bounded collision retries", async () => {
    const signer = new Ed25519TrainerCardSigner(KEY_PAIR.privateKey);
    const issue = vi.fn().mockResolvedValue(false);
    const service = new TrainerCardIssuanceService(
      { issue },
      signer,
      () => "tcv_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8",
      3,
    );

    await expect(service.issue(SNAPSHOT)).rejects.toThrow("trainer card public id collision");
    expect(issue).toHaveBeenCalledTimes(3);
  });
});
