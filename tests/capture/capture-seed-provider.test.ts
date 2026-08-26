import { describe, expect, it } from "vitest";
import { HmacAesCaptureSeedProvider } from "../../src/platform/capture/hmac-aes-capture-seed-provider.js";
import { decryptRngSeed } from "../../src/platform/db/encrypted-seed.js";

const DOMAIN = "pokemon-rpg:capture-seed:v1:";
const DERIVATION_KEY = Buffer.alloc(32, 0x31);
const ENCRYPTION_KEY = Buffer.alloc(32, 0x52);

function aad(context: string): Buffer {
  return Buffer.from(`${DOMAIN}${context}`);
}

describe("HmacAesCaptureSeedProvider", () => {
  it("derives the same private seed for the same semantic context across retries", () => {
    const provider = new HmacAesCaptureSeedProvider(DERIVATION_KEY, ENCRYPTION_KEY, 7);
    const context = "capture.attempt:player:key:fingerprint";

    const first = provider.create(context);
    const retry = provider.create(context);

    expect(first.seed).toEqual(retry.seed);
    expect(first.seed).toHaveLength(32);
    expect(first.envelope.keyVersion).toBe(7);
    expect(retry.envelope.keyVersion).toBe(7);

    expect(
      decryptRngSeed(
        {
          ciphertext: Buffer.from(first.envelope.ciphertext),
          iv: Buffer.from(first.envelope.iv),
          authTag: Buffer.from(first.envelope.authTag),
          keyVersion: first.envelope.keyVersion,
        },
        ENCRYPTION_KEY,
        aad(context),
      ),
    ).toEqual(first.seed);
    expect(
      decryptRngSeed(
        {
          ciphertext: Buffer.from(retry.envelope.ciphertext),
          iv: Buffer.from(retry.envelope.iv),
          authTag: Buffer.from(retry.envelope.authTag),
          keyVersion: retry.envelope.keyVersion,
        },
        ENCRYPTION_KEY,
        aad(context),
      ),
    ).toEqual(retry.seed);

    // Encryption remains nonce-random even though the mechanical seed is deterministic.
    expect(first.envelope.iv).not.toEqual(retry.envelope.iv);
  });

  it("changes the seed when the semantic request context changes", () => {
    const provider = new HmacAesCaptureSeedProvider(DERIVATION_KEY, ENCRYPTION_KEY, 1);

    const first = provider.create("capture-key-a:fingerprint-a");
    const second = provider.create("capture-key-a:fingerprint-b");
    const third = provider.create("capture-key-b:fingerprint-a");

    expect(first.seed).not.toEqual(second.seed);
    expect(first.seed).not.toEqual(third.seed);
  });

  it("binds the encrypted evidence to the exact capture context", () => {
    const provider = new HmacAesCaptureSeedProvider(DERIVATION_KEY, ENCRYPTION_KEY, 3);
    const context = "capture-key:fingerprint";
    const created = provider.create(context);
    const envelope = {
      ciphertext: Buffer.from(created.envelope.ciphertext),
      iv: Buffer.from(created.envelope.iv),
      authTag: Buffer.from(created.envelope.authTag),
      keyVersion: created.envelope.keyVersion,
    };

    expect(() => decryptRngSeed(envelope, ENCRYPTION_KEY, aad("different-context"))).toThrow();
  });

  it("rejects invalid keys, versions and empty contexts", () => {
    expect(() => new HmacAesCaptureSeedProvider(Buffer.alloc(31), ENCRYPTION_KEY, 1)).toThrow();
    expect(() => new HmacAesCaptureSeedProvider(DERIVATION_KEY, Buffer.alloc(31), 1)).toThrow();
    expect(() => new HmacAesCaptureSeedProvider(DERIVATION_KEY, ENCRYPTION_KEY, 0)).toThrow();

    const provider = new HmacAesCaptureSeedProvider(DERIVATION_KEY, ENCRYPTION_KEY, 1);
    expect(() => provider.create("")).toThrow();
  });
});
