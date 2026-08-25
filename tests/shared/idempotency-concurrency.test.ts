import { describe, expect, it } from "vitest";
import {
  checkExpectedRevision,
  checkExpectedVersion,
  deriveIdempotencyKey,
  scopedIdempotencyKey,
} from "../../src/platform/shared/index.js";

describe("idempotency and optimistic concurrency", () => {
  it("derives stable keys while preserving part boundaries", () => {
    const first = deriveIdempotencyKey("capture.attempt", ["ab", "c"]);
    const same = deriveIdempotencyKey("capture.attempt", ["ab", "c"]);
    const differentBoundary = deriveIdempotencyKey("capture.attempt", ["a", "bc"]);

    expect(first).toEqual(same);
    expect(first.key).not.toBe(differentBoundary.key);
    expect(first.scope).toBe("capture.attempt");
  });

  it("rejects invalid idempotency scopes and empty keys", () => {
    expect(() => scopedIdempotencyKey("Capture Attempt", "key")).toThrow(/scope/);
    expect(() => scopedIdempotencyKey("capture.attempt", "")).toThrow(/1\.\.256/);
  });

  it("returns stable stale-revision errors instead of silently overwriting", () => {
    const match = checkExpectedRevision("player", 4n, 4n);
    const stale = checkExpectedRevision("player", 5n, 4n);

    expect(match).toEqual({ ok: true, value: undefined });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("CONCURRENCY.STALE_REVISION");
      expect(stale.error.details).toEqual({ resource: "player", actual: 5n, expected: 4n });
    }
  });

  it("keeps revision and version conflicts distinct", () => {
    const stale = checkExpectedVersion("battle", 9n, 8n);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("CONCURRENCY.STALE_VERSION");
    }
  });

  it("rejects impossible negative counters", () => {
    expect(() => checkExpectedVersion("battle", -1n, 0n)).toThrow(/negative/);
  });
});
