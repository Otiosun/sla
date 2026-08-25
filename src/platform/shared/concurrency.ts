import { appError, err, ok, type AppError, type Result } from "./result.js";

export type StaleRevisionError = AppError<
  "CONCURRENCY.STALE_REVISION",
  {
    readonly resource: string;
    readonly actual: bigint;
    readonly expected: bigint;
  }
>;

export type StaleVersionError = AppError<
  "CONCURRENCY.STALE_VERSION",
  {
    readonly resource: string;
    readonly actual: bigint;
    readonly expected: bigint;
  }
>;

function validateCounter(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} cannot be negative`);
  }
}

export function checkExpectedRevision(
  resource: string,
  actual: bigint,
  expected: bigint,
): Result<void, StaleRevisionError> {
  validateCounter(actual, "actual revision");
  validateCounter(expected, "expected revision");

  if (actual === expected) {
    return ok(undefined);
  }

  return err(
    appError({
      code: "CONCURRENCY.STALE_REVISION",
      message: "Resource revision no longer matches the caller expectation",
      retryable: false,
      details: { resource, actual, expected },
    }),
  );
}

export function checkExpectedVersion(
  resource: string,
  actual: bigint,
  expected: bigint,
): Result<void, StaleVersionError> {
  validateCounter(actual, "actual version");
  validateCounter(expected, "expected version");

  if (actual === expected) {
    return ok(undefined);
  }

  return err(
    appError({
      code: "CONCURRENCY.STALE_VERSION",
      message: "Resource version no longer matches the caller expectation",
      retryable: false,
      details: { resource, actual, expected },
    }),
  );
}
