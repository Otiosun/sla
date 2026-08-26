import { randomBytes } from "node:crypto";
import type { EncounterSeedProvider, SeedMaterial } from "../../modules/encounter/ports.js";
import { encryptRngSeed } from "../db/encrypted-seed.js";

const SEED_BYTES = 32;
const KEY_BYTES = 32;

export type SeedFactory = () => Uint8Array;

export class AesEncounterSeedProvider implements EncounterSeedProvider {
  private readonly key: Buffer;

  public constructor(
    key: Uint8Array,
    private readonly keyVersion: number,
    private readonly seedFactory: SeedFactory = () => randomBytes(SEED_BYTES),
  ) {
    if (key.byteLength !== KEY_BYTES) {
      throw new RangeError(`Encounter RNG key must be exactly ${KEY_BYTES} bytes`);
    }
    if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
      throw new RangeError("Encounter RNG key version must be a positive safe integer");
    }
    this.key = Buffer.from(key);
  }

  public create(context: string): SeedMaterial {
    if (context.length === 0) throw new Error("Encounter RNG seed context cannot be empty");
    const seed = Buffer.from(this.seedFactory());
    if (seed.byteLength !== SEED_BYTES) {
      throw new RangeError(`Encounter RNG seed factory must return exactly ${SEED_BYTES} bytes`);
    }
    const encrypted = encryptRngSeed(seed, this.key, this.keyVersion, Buffer.from(context));
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
