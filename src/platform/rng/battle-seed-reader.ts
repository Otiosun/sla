import type { BattleRootRecord, BattleSeedReader } from "../../modules/battle/ports.js";
import { decryptRngSeed } from "../db/encrypted-seed.js";

const KEY_BYTES = 32;

export class AesBattleSeedReader implements BattleSeedReader {
  private readonly keys = new Map<number, Buffer>();

  public constructor(keys: ReadonlyMap<number, Uint8Array>) {
    if (keys.size === 0) throw new RangeError("At least one Battle RNG key is required");
    for (const [version, key] of keys) {
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new RangeError("Battle RNG key versions must be positive safe integers");
      }
      if (key.byteLength !== KEY_BYTES) {
        throw new RangeError(`Battle RNG keys must be exactly ${KEY_BYTES} bytes`);
      }
      this.keys.set(version, Buffer.from(key));
    }
  }

  public decrypt(root: BattleRootRecord): Uint8Array {
    const key = this.keys.get(root.seed.keyVersion);
    if (key === undefined) {
      throw new Error(`Battle RNG key version ${root.seed.keyVersion} is unavailable`);
    }
    return decryptRngSeed(
      {
        ciphertext: Buffer.from(root.seed.ciphertext),
        iv: Buffer.from(root.seed.iv),
        authTag: Buffer.from(root.seed.authTag),
        keyVersion: root.seed.keyVersion,
      },
      key,
      Buffer.from(`battle:${root.battleId}`),
    );
  }
}
