import { describe, expect, it } from "vitest";
import type { CaptureProbabilityInput } from "../../src/modules/capture/contracts.js";
import { captureProbability } from "../../src/modules/capture/probability.js";

const STATUSES: CaptureProbabilityInput["status"][] = [
  null,
  "BURN",
  "POISON",
  "PARALYSIS",
  "SLEEP",
  "FREEZE",
];

class DeterministicRandom {
  private state = 0x6d2b79f5;

  public next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state;
  }

  public int(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }
}

function assertValidResult(input: CaptureProbabilityInput): void {
  const first = captureProbability(input);
  const second = captureProbability(structuredClone(input));

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Capture probability is not deterministic for identical input");
  }
  if (!Number.isInteger(first.probabilityBasisPoints)) {
    throw new Error("Capture probability left integer basis-point space");
  }
  if (
    first.probabilityBasisPoints < 0 ||
    first.probabilityBasisPoints > input.ruleset.maxProbabilityBasisPoints ||
    first.probabilityBasisPoints > 10_000
  ) {
    throw new Error("Capture probability escaped the canonical clamp");
  }
  if (first.breakdown.finalProbabilityBasisPoints !== first.probabilityBasisPoints) {
    throw new Error("Capture breakdown diverged from final probability");
  }

  const lowerHp = Math.max(1, input.currentHp - Math.max(1, Math.floor(input.maxHp / 7)));
  const lowerHpResult = captureProbability({ ...input, currentHp: lowerHp });
  if (lowerHpResult.probabilityBasisPoints < first.probabilityBasisPoints) {
    throw new Error("Lower HP reduced capture probability");
  }

  const reversed = captureProbability({
    ...input,
    explicitModifierBasisPoints: [...input.explicitModifierBasisPoints].reverse(),
  });
  if (reversed.probabilityBasisPoints !== first.probabilityBasisPoints) {
    throw new Error("Modifier ordering changed capture probability");
  }
}

describe("Capture probability volume properties", () => {
  it("fuzzes 25,000 valid capture states without impossible probability", () => {
    const random = new DeterministicRandom();
    const samples = 25_000;

    for (let sample = 0; sample < samples; sample += 1) {
      const maxHp = random.int(1, 999_999);
      const modifierCount = random.int(0, 6);
      const modifiers = Array.from({ length: modifierCount }, () => random.int(1, 100_000));
      const input: CaptureProbabilityInput = {
        catchRate: random.int(0, 255),
        currentHp: random.int(1, maxHp),
        maxHp,
        ballMultiplierBasisPoints: random.int(1, 100_000),
        status: STATUSES[random.int(0, STATUSES.length - 1)] ?? null,
        explicitModifierBasisPoints: modifiers,
        ruleset: {
          model: "POKEMON_INSPIRED_V1",
          maxProbabilityBasisPoints: random.int(1, 10_000),
        },
      };

      assertValidResult(input);
    }

    expect(samples).toBe(25_000);
  }, 20_000);
});
