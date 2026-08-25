import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedRngSeed {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be exactly ${KEY_BYTES} bytes`);
  }
}

function assertKeyVersion(keyVersion: number): void {
  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
    throw new Error("RNG seed keyVersion must be a positive safe integer");
  }
}

export function encryptRngSeed(
  seed: Uint8Array,
  key: Uint8Array,
  keyVersion: number,
  associatedData: Uint8Array,
): EncryptedRngSeed {
  assertKey(key);
  assertKeyVersion(keyVersion);
  if (seed.byteLength === 0) throw new Error("RNG seed cannot be empty");
  if (associatedData.byteLength === 0) throw new Error("RNG seed associated data cannot be empty");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

export function decryptRngSeed(
  encrypted: EncryptedRngSeed,
  key: Uint8Array,
  associatedData: Uint8Array,
): Buffer {
  assertKey(key);
  assertKeyVersion(encrypted.keyVersion);
  if (associatedData.byteLength === 0) throw new Error("RNG seed associated data cannot be empty");
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}
