import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRngSeed, encryptRngSeed } from "../../src/platform/db/encrypted-seed.js";

describe("encrypted RNG seed envelope", () => {
  it("round-trips a seed with AES-256-GCM and explicit key version", () => {
    const key = randomBytes(32);
    const seed = randomBytes(32);
    const aad = Buffer.from("encounter:11111111-1111-1111-1111-111111111111");
    const encrypted = encryptRngSeed(seed, key, 1, aad);

    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag.byteLength).toBeGreaterThan(0);
    expect(encrypted.ciphertext.equals(seed)).toBe(false);
    expect(decryptRngSeed(encrypted, key, aad)).toEqual(seed);
  });

  it("rejects tampering or wrong associated data", () => {
    const key = randomBytes(32);
    const seed = randomBytes(32);
    const encrypted = encryptRngSeed(seed, key, 2, Buffer.from("battle:a"));
    expect(() => decryptRngSeed(encrypted, key, Buffer.from("battle:b"))).toThrow();
  });

  it("rejects keys that are not 256 bits", () => {
    expect(() =>
      encryptRngSeed(randomBytes(32), randomBytes(16), 1, Buffer.from("encounter:test")),
    ).toThrow(/32 bytes/);
  });
});
