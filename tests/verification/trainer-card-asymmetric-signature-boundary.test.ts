import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as verificationModule from "../../src/modules/verification/trainer-card-verification.js";
import type { TrainerCardPublicSnapshot } from "../../src/modules/verification/trainer-card-verification.js";

interface SnapshotSigner {
  sign(snapshot: TrainerCardPublicSnapshot): string;
}

interface SnapshotVerifier {
  verify(snapshot: TrainerCardPublicSnapshot, signature: string): boolean;
}

type SignerConstructor = new (privateKey: Uint8Array) => SnapshotSigner;
type VerifierConstructor = new (publicKey: Uint8Array) => SnapshotVerifier;

const SNAPSHOT: TrainerCardPublicSnapshot = {
  version: 1,
  trainerName: "Leaf",
  trainerTitle: "Treinadora de Kanto",
  originRegion: "Kanto",
  currentLocation: "Pallet Town",
  leadPokemon: { dex: 1, nickname: "Bulbasaur" },
  earnedBadgeKeys: ["boulder"],
  issuedAt: "2026-09-08T00:00:00.000Z",
};

function exportedConstructor<T>(name: string): T | undefined {
  const exports = verificationModule as unknown as Record<string, unknown>;
  return exports[name] as T | undefined;
}

describe("trainer-card asymmetric signature boundary", () => {
  it("signs with an Ed25519 private key and verifies with the public key only", () => {
    const Signer = exportedConstructor<SignerConstructor>("Ed25519TrainerCardSigner");
    const Verifier = exportedConstructor<VerifierConstructor>("Ed25519TrainerCardVerifier");

    expect(Signer).toBeTypeOf("function");
    expect(Verifier).toBeTypeOf("function");
    if (Signer === undefined || Verifier === undefined) return;

    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "der", type: "pkcs8" },
      publicKeyEncoding: { format: "der", type: "spki" },
    });
    const signer = new Signer(privateKey);
    const verifier = new Verifier(publicKey);
    const signature = signer.sign(SNAPSHOT);

    expect(signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
    expect(verifier.verify(SNAPSHOT, signature)).toBe(true);
    expect(verifier.verify({ ...SNAPSHOT, trainerName: "Mallory" }, signature)).toBe(false);
    expect("sign" in verifier).toBe(false);
  });

  it("keeps private signing material out of the public runtime composition and config", async () => {
    const compose = await readFile(
      new URL("../../src/runtime/compose-public-verification.ts", import.meta.url),
      "utf8",
    );
    const config = await readFile(
      new URL("../../src/runtime/public-verification-runtime-config.ts", import.meta.url),
      "utf8",
    );

    expect(compose).not.toContain("HmacTrainerCardSigner");
    expect(compose).not.toContain("signingKey");
    expect(config).not.toContain("PUBLIC_VERIFICATION_SIGNING_KEY_BASE64");
    expect(config).not.toContain("signingKey");
    expect(compose).toContain("publicKey");
    expect(config).toContain("PUBLIC_VERIFICATION_PUBLIC_KEY_BASE64");
  });
});
