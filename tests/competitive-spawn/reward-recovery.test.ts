import { describe, expect, it, vi } from "vitest";
import { CompetitiveSpawnRewardRecoveryWorker } from "../../src/modules/competitive-spawn/reward-recovery.js";

const intent = {
  spawnId: "11111111-1111-4111-8111-111111111111",
  playerId: "22222222-2222-4222-8222-222222222222",
  correlationId: "33333333-3333-4333-8333-333333333333",
  reward: {
    kind: "PROGRESSION" as const,
    amount: 10,
    currencyId: null,
    itemId: null,
    displayName: "Progressão +10",
  },
  attempts: 1,
};

describe("competitive reward recovery", () => {
  it("applies a pending intent and then projects its winner", async () => {
    const repository = {
      claimPending: vi.fn().mockResolvedValue([intent]),
      markApplied: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      projectAppliedWinners: vi.fn().mockResolvedValue(1),
    };
    const application = { apply: vi.fn().mockResolvedValue(undefined) };
    const worker = new CompetitiveSpawnRewardRecoveryWorker(repository, application);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      applied: 1,
      failed: 0,
      projected: 1,
    });
    expect(application.apply).toHaveBeenCalledTimes(1);
    expect(repository.markApplied).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("persists exponential retry state instead of losing the reward", async () => {
    const repository = {
      claimPending: vi.fn().mockResolvedValue([intent]),
      markApplied: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      projectAppliedWinners: vi.fn().mockResolvedValue(0),
    };
    const application = { apply: vi.fn().mockRejectedValue(new Error("temporary")) };
    const now = new Date("2026-10-08T23:00:00.000Z");
    const worker = new CompetitiveSpawnRewardRecoveryWorker(
      repository,
      application,
      {
        batchSize: 25,
        leaseMs: 30_000,
        maxAttempts: 10,
        baseBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      },
      () => now,
    );

    const result = await worker.runOnce();
    expect(result.failed).toBe(1);
    expect(repository.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnId: intent.spawnId,
        retryAt: new Date("2026-10-08T23:00:01.000Z"),
      }),
    );
  });
});
