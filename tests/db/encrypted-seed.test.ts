import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRngSeed, encryptRngSeed } from "../../src/platform/db/encrypted-seed.js";

describe("encrypted RNG seed envelope", () => {
  it("round-trips a 256-bit seed with AES-256-GCM and explicit key version", () => {
    const key = randomBytes(32);
    const seed = randomBytes(32);
    const aad = Buffer.from("encounter:11111111-1111-1111-1111-111111111111");
    const encrypted = encryptRngSeed(seed, key, 1, aad);

    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.ciphertext).toHaveLength(32);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.equals(seed)).toBe(false);
    expect(decryptRngSeed(encrypted, key, aad)).toEqual(seed);
  });

  it("rejects tampering or wrong associated data", () => {
    const key = randomBytes(32);
    const seed = randomBytes(32);
    const encrypted = encryptRngSeed(seed, key, 2, Buffer.from("battle:a"));
    expect(() => decryptRngSeed(encrypted, key, Buffer.from("battle:b"))).toThrow();
  });

  it("rejects keys or seeds that are not exactly 256 bits", () => {
    expect(() =>
      encryptRngSeed(randomBytes(32), randomBytes(16), 1, Buffer.from("encounter:test")),
    ).toThrow(/32 bytes/);
    expect(() =>
      encryptRngSeed(randomBytes(31), randomBytes(32), 1, Buffer.from("encounter:test")),
    ).toThrow(/RNG seed must be exactly 32 bytes/);
  });

  it("rejects malformed persisted envelope lengths before decryption", () => {
    const key = randomBytes(32);
    const seed = randomBytes(32);
    const aad = Buffer.from("battle:test");
    const encrypted = encryptRngSeed(seed, key, 3, aad);

    expect(() =>
      decryptRngSeed({ ...encrypted, iv: randomBytes(11) }, key, aad),
    ).toThrow(/IV must be exactly 12 bytes/);
    expect(() =>
      decryptRngSeed({ ...encrypted, authTag: randomBytes(15) }, key, aad),
    ).toThrow(/auth tag must be exactly 16 bytes/);
  });
});
