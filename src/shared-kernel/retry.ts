import type { RandomSource } from "../platform/rng/index.js";

export type RetrySafety =
  | { readonly kind: "READ_ONLY" }
  | { readonly kind: "IDEMPOTENT_MUTATION"; readonly idempotencyKey: string };

export interface SafeRetryPolicy {
  readonly safety: RetrySafety;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly isRetryable: (error: unknown) => boolean;
}

export interface RetryDependencies {
  readonly rng: RandomSource;
  readonly sleep: (delayMs: number) => Promise<void>;
}

function assertPolicy(policy: SafeRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError("Retry delays are invalid");
  }
  if (policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }
  if (
    policy.safety.kind === "IDEMPOTENT_MUTATION" &&
    policy.safety.idempotencyKey.trim().length === 0
  ) {
    throw new RangeError("Idempotent mutation retries require an idempotency key");
  }
}

export function retryDelayMs(
  policy: SafeRetryPolicy,
  failedAttempt: number,
  randomFloat: number,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
  const jitterWindow = exponential * policy.jitterRatio;
  const jitter = (randomFloat * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(exponential + jitter));
}

export async function withSafeRetry<T>(
  operation: () => Promise<T>,
  policy: SafeRetryPolicy,
  dependencies: RetryDependencies,
): Promise<T> {
  assertPolicy(policy);

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const canRetry = attempt < policy.maxAttempts && policy.isRetryable(error);
      if (!canRetry) {
        throw error;
      }
      await dependencies.sleep(retryDelayMs(policy, attempt, dependencies.rng.randomFloat()));
    }
  }

  throw new Error("Unreachable retry state");
}
