import { createHash } from "node:crypto";
import { appError, err, ok, type Result } from "./result.js";
import type { Brand } from "./ids.js";

export type IdempotencyScope = Brand<string, "IdempotencyScope">;
export type IdempotencyStorageKey = Brand<string, "IdempotencyStorageKey">;

export interface ScopedIdempotencyKey {
  readonly scope: IdempotencyScope;
  readonly storageKey: IdempotencyStorageKey;
}

const scopePattern = /^[a-z][a-z0-9._:-]{1,63}$/;

export function parseIdempotencyScope(value: string): Result<IdempotencyScope> {
  if (!scopePattern.test(value)) {
    return err(
      appError("IDEMPOTENCY_KEY_INVALID", "Invalid idempotency scope", {
        scope: value,
      }),
    );
  }
  return ok(value as IdempotencyScope);
}

export function createIdempotencyKey(
  scope: IdempotencyScope,
  externalKey: string,
): Result<ScopedIdempotencyKey> {
  const normalized = externalKey.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    return err(
      appError("IDEMPOTENCY_KEY_INVALID", "Invalid external idempotency key length", {
        length: normalized.length,
      }),
    );
  }

  const storageKey = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(normalized)
    .digest("hex") as IdempotencyStorageKey;

  return ok({ scope, storageKey });
}
