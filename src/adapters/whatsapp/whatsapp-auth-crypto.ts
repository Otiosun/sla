import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedWhatsAppAuthValue {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`WhatsApp auth encryption key must be exactly ${KEY_BYTES} bytes`);
  }
}

function associatedData(context: string): Buffer {
  if (context.length === 0) throw new Error("WhatsApp auth encryption context cannot be empty");
  return Buffer.from(context, "utf8");
}

export function encryptWhatsAppAuthValue(
  serialized: string,
  key: Uint8Array,
  context: string,
): EncryptedWhatsAppAuthValue {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  if (authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("WhatsApp auth encryption produced an invalid authentication tag");
  }
  return { ciphertext, iv, authTag };
}

export function decryptWhatsAppAuthValue(
  encrypted: EncryptedWhatsAppAuthValue,
  key: Uint8Array,
  context: string,
): string {
  assertKey(key);
  if (encrypted.iv.byteLength !== IV_BYTES || encrypted.authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("Stored WhatsApp auth envelope is invalid");
  }
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAAD(associatedData(context));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}
