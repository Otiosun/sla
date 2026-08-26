import { createHmac } from "node:crypto";
import type { RandomSource } from "./index.js";

const SEED_BYTES = 32;
const UINT64_SPACE = 1n << 64n;
const FLOAT_DENOMINATOR = 9_007_199_254_740_992; // 2^53

function assertSeed(seed: Uint8Array): void {
  if (seed.byteLength !== SEED_BYTES) {
    throw new RangeError(`Counter RNG seed must be exactly ${SEED_BYTES} bytes`);
  }
}

function assertCounter(counter: bigint): void {
  if (counter < 0n || counter > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("Counter RNG counter must fit in an unsigned 64-bit integer");
  }
}

function assertMaxExclusive(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive must be a positive safe integer");
  }
}

function counterBytes(counter: bigint): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(counter);
  return buffer;
}

export class CounterRandomSource implements RandomSource {
  private counterValue: bigint;
  private readonly seed: Buffer;

  public constructor(seed: Uint8Array, initialCounter = 0n) {
    assertSeed(seed);
    assertCounter(initialCounter);
    this.seed = Buffer.from(seed);
    this.counterValue = initialCounter;
  }

  public get counter(): bigint {
    return this.counterValue;
  }

  private nextUint64(): bigint {
    assertCounter(this.counterValue);
    const digest = createHmac("sha256", this.seed).update(counterBytes(this.counterValue)).digest();
    this.counterValue += 1n;
    return digest.readBigUInt64BE(0);
  }

  public randomFloat(): number {
    const value53 = this.nextUint64() >> 11n;
    return Number(value53) / FLOAT_DENOMINATOR;
  }

  public randomInt(maxExclusive: number): number {
    assertMaxExclusive(maxExclusive);
    const modulus = BigInt(maxExclusive);
    const limit = UINT64_SPACE - (UINT64_SPACE % modulus);
    while (true) {
      const value = this.nextUint64();
      if (value < limit) return Number(value % modulus);
    }
  }
}
