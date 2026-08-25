import { MAX_SLEEP_MS, systemSleeper, type Sleeper } from "../clock/index.js";

export type RetrySafety = "READ_ONLY" | "IDEMPOTENT";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export async function runWithSafeRetry<T>(input: {
  readonly safety: RetrySafety;
  readonly policy: RetryPolicy;
  readonly operation: (attempt: number) => Promise<T>;
  readonly shouldRetry: (error: unknown, attempt: number) => boolean;
  readonly sleeper?: Sleeper;
}): Promise<T> {
  validatePolicy(input.policy);
  const sleeper = input.sleeper ?? systemSleeper;

  for (let attempt = 1; attempt <= input.policy.maxAttempts; attempt += 1) {
    try {
      return await input.operation(attempt);
    } catch (error) {
      const isLastAttempt = attempt >= input.policy.maxAttempts;
      if (isLastAttempt || !input.shouldRetry(error, attempt)) {
        throw error;
      }

      const exponent = Math.min(attempt - 1, 30);
      const delay = Math.min(input.policy.maxDelayMs, input.policy.baseDelayMs * 2 ** exponent);
      await sleeper.sleep(delay);
    }
  }

  throw new Error(`unreachable retry state for ${input.safety}`);
}

function validatePolicy(policy: RetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20
  ) {
    throw new RangeError("retry maxAttempts must be an integer in 1..20");
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new RangeError("retry baseDelayMs must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.maxDelayMs > MAX_SLEEP_MS
  ) {
    throw new RangeError(`retry maxDelayMs must be an integer in baseDelayMs..${MAX_SLEEP_MS}`);
  }
}
