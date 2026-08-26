import {
  CaptureProbabilityInputSchema,
  type CaptureProbabilityInput,
  type CaptureProbabilityResult,
} from "./contracts.js";

const BASIS = 10_000n;
const MAX_CATCH_RATE = 255n;

function scaledProduct(left: bigint, rightBasisPoints: bigint): bigint {
  return (left * rightBasisPoints) / BASIS;
}

function statusMultiplierBasisPoints(status: CaptureProbabilityInput["status"]): number {
  switch (status) {
    case "SLEEP":
    case "FREEZE":
      return 20_000;
    case "BURN":
    case "POISON":
    case "PARALYSIS":
      return 15_000;
    case null:
      return 10_000;
  }
}

export function captureProbability(input: CaptureProbabilityInput): CaptureProbabilityResult {
  const parsed = CaptureProbabilityInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RangeError(
      `Invalid capture probability input: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const value = parsed.data;

  const catchRateBasisPoints = Number((BigInt(value.catchRate) * BASIS) / MAX_CATCH_RATE);
  const hpNumerator = BigInt(3 * value.maxHp - 2 * value.currentHp);
  const hpDenominator = BigInt(3 * value.maxHp);
  const hpFactorBasisPoints = Number((hpNumerator * BASIS) / hpDenominator);
  const statusMultiplier = statusMultiplierBasisPoints(value.status);
  const explicitModifiers = [...value.explicitModifierBasisPoints].sort(
    (left, right) => left - right,
  );

  let probability = BigInt(catchRateBasisPoints);
  probability = scaledProduct(probability, BigInt(hpFactorBasisPoints));
  probability = scaledProduct(probability, BigInt(value.ballMultiplierBasisPoints));
  probability = scaledProduct(probability, BigInt(statusMultiplier));
  for (const modifier of explicitModifiers) {
    probability = scaledProduct(probability, BigInt(modifier));
  }

  const rawProbabilityBasisPoints = Number(probability > BASIS ? BASIS : probability);
  const finalProbabilityBasisPoints = Math.min(
    rawProbabilityBasisPoints,
    value.ruleset.maxProbabilityBasisPoints,
  );

  return {
    probabilityBasisPoints: finalProbabilityBasisPoints,
    breakdown: {
      model: "POKEMON_INSPIRED_V1",
      catchRate: value.catchRate,
      catchRateBasisPoints,
      currentHp: value.currentHp,
      maxHp: value.maxHp,
      hpFactorBasisPoints,
      ballMultiplierBasisPoints: value.ballMultiplierBasisPoints,
      status: value.status,
      statusMultiplierBasisPoints: statusMultiplier,
      explicitModifierBasisPoints: explicitModifiers,
      rawProbabilityBasisPoints,
      maxProbabilityBasisPoints: value.ruleset.maxProbabilityBasisPoints,
      finalProbabilityBasisPoints,
    },
  };
}
