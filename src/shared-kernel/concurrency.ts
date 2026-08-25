import { appError, err, ok, type Result } from "./result.js";
import type { Brand } from "./ids.js";

export type Revision = Brand<number, "Revision">;

export function revision(value: number): Revision {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Revision must be a non-negative safe integer");
  }
  return value as Revision;
}

export function requireExpectedRevision(
  actual: Revision,
  expected: Revision,
): Result<void> {
  if (actual !== expected) {
    return err(
      appError("REVISION_CONFLICT", "Stale revision", {
        actual,
        expected,
      }),
    );
  }
  return ok(undefined);
}

export function nextRevision(current: Revision): Revision {
  return revision(current + 1);
}
