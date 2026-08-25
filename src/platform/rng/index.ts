import { randomBytes, randomInt as cryptoRandomInt } from "node:crypto";

export interface RandomSource {
  randomFloat(): number;
  randomInt(maxExclusive: number): number;
}

function assertMaxExclusive(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive must be a positive safe integer");
  }
}

export class CryptoRandomSource implements RandomSource {
  public randomFloat(): number {
    const buffer = randomBytes(6);
    return buffer.readUIntBE(0, 6) / 281_474_976_710_656;
  }

  public randomInt(maxExclusive: number): number {
    assertMaxExclusive(maxExclusive);
    return cryptoRandomInt(maxExclusive);
  }
}

export class DeterministicRandomSource implements RandomSource {
  private state: number;

  public constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError("Deterministic RNG seed must be a safe integer");
    }
    this.state = seed >>> 0;
  }

  public randomFloat(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public randomInt(maxExclusive: number): number {
    assertMaxExclusive(maxExclusive);
    return Math.floor(this.randomFloat() * maxExclusive);
  }
}
