import type { ZodType } from "zod";
import { appError, err, ok, type Result } from "./result.js";

export function parseContract<T>(schema: ZodType<T>, input: unknown): Result<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    appError("VALIDATION_FAILED", "Contract validation failed", {
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join("."),
      })),
    }),
  );
}
