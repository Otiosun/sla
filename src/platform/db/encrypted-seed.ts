import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const SEED_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedRngSeed {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

function assertExactLength(value: Uint8Array, expectedBytes: number, label: string): void {
  if (value.byteLength !== expectedBytes) {
    throw new Error(`${label} must be exactly ${expectedBytes} bytes`);
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
  assertExactLength(key, KEY_BYTES, "AES-256-GCM key");
  assertExactLength(seed, SEED_BYTES, "RNG seed");
  assertKeyVersion(keyVersion);
  if (associatedData.byteLength === 0) throw new Error("RNG seed associated data cannot be empty");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  assertExactLength(authTag, AUTH_TAG_BYTES, "AES-256-GCM auth tag");

  return { ciphertext, iv, authTag, keyVersion };
}

export function decryptRngSeed(
  encrypted: EncryptedRngSeed,
  key: Uint8Array,
  associatedData: Uint8Array,
): Buffer {
  assertExactLength(key, KEY_BYTES, "AES-256-GCM key");
  assertExactLength(encrypted.ciphertext, SEED_BYTES, "Encrypted RNG seed ciphertext");
  assertExactLength(encrypted.iv, IV_BYTES, "AES-256-GCM IV");
  assertExactLength(encrypted.authTag, AUTH_TAG_BYTES, "AES-256-GCM auth tag");
  assertKeyVersion(encrypted.keyVersion);
  if (associatedData.byteLength === 0) throw new Error("RNG seed associated data cannot be empty");

  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}
