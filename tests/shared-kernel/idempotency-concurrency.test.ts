import { describe, expect, it } from "vitest";
import {
  createIdempotencyKey,
  parseIdempotencyScope,
} from "../../src/shared-kernel/idempotency.js";
import {
  nextRevision,
  requireExpectedRevision,
  revision,
} from "../../src/shared-kernel/concurrency.js";

describe("idempotency and optimistic concurrency", () => {
  it("scopes and hashes external idempotency keys deterministically", () => {
    const scope = parseIdempotencyScope("capture.attempt");
    expect(scope.ok).toBe(true);
    if (!scope.ok) {
      return;
    }

    const first = createIdempotencyKey(scope.value, "provider-message-123");
    const second = createIdempotencyKey(scope.value, "provider-message-123");
    expect(first).toEqual(second);
    if (first.ok) {
      expect(first.value.storageKey).toMatch(/^[a-f0-9]{64}$/);
      expect(first.value.storageKey).not.toContain("provider-message-123");
    }
  });

  it("rejects empty external idempotency keys", () => {
    const scope = parseIdempotencyScope("battle.action");
    if (!scope.ok) {
      throw new Error("test scope must be valid");
    }
    const result = createIdempotencyKey(scope.value, "   ");
    expect(result.ok).toBe(false);
  });

  it("accepts only the expected revision and advances safely", () => {
    const current = revision(7);
    expect(requireExpectedRevision(current, revision(7)).ok).toBe(true);

    const stale = requireExpectedRevision(current, revision(6));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("REVISION_CONFLICT");
    }
    expect(nextRevision(current)).toBe(8);
  });
});
