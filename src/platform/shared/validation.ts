import { z, type ZodType } from "zod";
import {
  appError,
  err,
  ok,
  STABLE_ERROR_CODE_PATTERN,
  type AppError,
  type Result,
} from "./result.js";

export const stableErrorCodeSchema = z
  .string()
  .regex(STABLE_ERROR_CODE_PATTERN, "error code must be namespace-qualified and stable");

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type InputValidationError = AppError<
  "VALIDATION.INVALID_INPUT",
  { readonly issues: readonly ValidationIssue[] }
>;

export function parseInput<T>(schema: ZodType<T>, input: unknown): Result<T, InputValidationError> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    appError({
      code: "VALIDATION.INVALID_INPUT",
      message: "Input failed schema validation",
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    }),
  );
}
