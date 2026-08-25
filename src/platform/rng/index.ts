import { createHmac, randomBytes } from "node:crypto";

export const RNG_SEED_BYTES = 32;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_COUNTER = (1n << 64n) - 1n;

export interface RandomSource {
  nextUint32(): number;
  nextFloat(): number;
  nextInt(minInclusive: number, maxExclusive: number): number;
}

export function generatePrivateSeed(): Uint8Array {
  return randomBytes(RNG_SEED_BYTES);
}

export class HmacCounterRandomSource implements RandomSource {
  readonly #seed: Buffer;
  #counter: bigint;

  constructor(seed: Uint8Array, initialCounter = 0n) {
    if (seed.byteLength !== RNG_SEED_BYTES) {
      throw new RangeError(`rng seed must be exactly ${RNG_SEED_BYTES} bytes`);
    }
    if (initialCounter < 0n || initialCounter > MAX_COUNTER) {
      throw new RangeError("rng counter must fit unsigned 64-bit range");
    }
    this.#seed = Buffer.from(seed);
    this.#counter = initialCounter;
  }

  getCounter(): bigint {
    return this.#counter;
  }

  nextUint32(): number {
    if (this.#counter > MAX_COUNTER) {
      throw new RangeError("rng counter exhausted");
    }

    const counterBytes = Buffer.allocUnsafe(8);
    counterBytes.writeBigUInt64BE(this.#counter);
    const digest = createHmac("sha256", this.#seed).update(counterBytes).digest();
    this.#counter += 1n;
    return digest.readUInt32BE(0);
  }

  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isSafeInteger(minInclusive) || !Number.isSafeInteger(maxExclusive)) {
      throw new RangeError("rng integer bounds must be safe integers");
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError("rng maxExclusive must be greater than minInclusive");
    }

    const range = maxExclusive - minInclusive;
    if (range > UINT32_RANGE) {
      throw new RangeError("rng integer range cannot exceed 2^32");
    }

    const acceptanceLimit = Math.floor(UINT32_RANGE / range) * range;
    let draw = this.nextUint32();
    while (draw >= acceptanceLimit) {
      draw = this.nextUint32();
    }
    return minInclusive + (draw % range);
  }
}
