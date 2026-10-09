import { describe, expect, it, vi } from "vitest";
import {
  COMPETITIVE_SPAWN_PUBLICATION_ORPHAN_GRACE_MS,
  COMPETITIVE_SPAWN_TTL_MS,
  CompetitiveSpawnService,
} from "../../src/modules/competitive-spawn/service.js";

describe("competitive spawn publication lifecycle", () => {
  it("uses SENT-time TTL reconciliation and a bounded orphan grace", async () => {
    const now = new Date("2026-10-09T00:00:00.000Z");
    const reconcilePublication = vi.fn(async () => ({ published: 1, cancelled: 2 }));
    const service = new CompetitiveSpawnService({
      repository: { reconcilePublication },
      now: () => now,
    } as never);

    await expect(service.reconcilePublication()).resolves.toEqual({ published: 1, cancelled: 2 });
    expect(reconcilePublication).toHaveBeenCalledWith({
      now,
      ttlMs: COMPETITIVE_SPAWN_TTL_MS,
      orphanGraceMs: COMPETITIVE_SPAWN_PUBLICATION_ORPHAN_GRACE_MS,
      limit: 100,
    });
  });
});
