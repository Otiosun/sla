import { createHmac } from "node:crypto";
import type { CaptureSeedProvider } from "../../modules/capture/ports.js";
import type { SeedMaterial } from "../../modules/encounter/ports.js";
import { encryptRngSeed } from "../db/encrypted-seed.js";

const KEY_BYTES = 32;
const DOMAIN = "pokemon-rpg:capture-seed:v1:";

function assertKey(value: Uint8Array, label: string): Buffer {
  if (value.byteLength !== KEY_BYTES) {
    throw new RangeError(`${label} must be exactly ${KEY_BYTES} bytes`);
  }
  return Buffer.from(value);
}

export class HmacAesCaptureSeedProvider implements CaptureSeedProvider {
  private readonly derivationKey: Buffer;
  private readonly encryptionKey: Buffer;

  public constructor(
    derivationKey: Uint8Array,
    encryptionKey: Uint8Array,
    private readonly keyVersion: number,
  ) {
    this.derivationKey = assertKey(derivationKey, "Capture RNG derivation key");
    this.encryptionKey = assertKey(encryptionKey, "Capture RNG encryption key");
    if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
      throw new RangeError("Capture RNG key version must be a positive safe integer");
    }
  }

  public create(context: string): SeedMaterial {
    if (context.length === 0) throw new Error("Capture RNG seed context cannot be empty");
    const associatedData = Buffer.from(`${DOMAIN}${context}`);
    const seed = createHmac("sha256", this.derivationKey).update(associatedData).digest();
    const encrypted = encryptRngSeed(seed, this.encryptionKey, this.keyVersion, associatedData);
    return {
      seed,
      envelope: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
    };
  }
}
