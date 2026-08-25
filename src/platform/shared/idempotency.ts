import { createHash } from "node:crypto";

declare const idempotencyScopeBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;

export type IdempotencyScope = string & { readonly [idempotencyScopeBrand]: true };
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

export interface ScopedIdempotencyKey {
  readonly scope: IdempotencyScope;
  readonly key: IdempotencyKey;
}

const SCOPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export function asIdempotencyScope(value: string): IdempotencyScope {
  if (!SCOPE_PATTERN.test(value)) {
    throw new TypeError("idempotency scope must match /^[a-z][a-z0-9_.:-]{0,127}$/");
  }
  return value as IdempotencyScope;
}

export function asIdempotencyKey(value: string): IdempotencyKey {
  if (value.length === 0 || value.length > 256) {
    throw new TypeError("idempotency key must contain 1..256 characters");
  }
  return value as IdempotencyKey;
}

export function scopedIdempotencyKey(scope: string, key: string): ScopedIdempotencyKey {
  return {
    scope: asIdempotencyScope(scope),
    key: asIdempotencyKey(key),
  };
}

export function deriveIdempotencyKey(scope: string, parts: readonly string[]): ScopedIdempotencyKey {
  if (parts.length === 0) {
    throw new TypeError("idempotency derivation requires at least one part");
  }

  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }

  return scopedIdempotencyKey(scope, hash.digest("hex"));
}
