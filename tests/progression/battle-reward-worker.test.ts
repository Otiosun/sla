import { describe, expect, it } from "vitest";
import type { BattleRewardResult } from "../../src/modules/progression/contracts.js";
import {
  BattleRewardWorker,
  type BattleRewardCandidateSource,
  type BattleRewardExecutor,
} from "../../src/modules/progression/battle-reward-worker.js";
import type { ProgressionResult } from "../../src/modules/progression/errors.js";

const BATTLE_A = "11111111-1111-4111-8111-111111111111";
const BATTLE_B = "22222222-2222-4222-8222-222222222222";

function reward(battleId: string, replayed: boolean): BattleRewardResult {
  return {
    battleId,
    playerId: "33333333-3333-4333-8333-333333333333",
    pokemon: [],
    trainer: {
      playerId: "33333333-3333-4333-8333-333333333333",
      beforeLevel: 1,
      beforePoints: 0,
      afterLevel: 1,
      afterPoints: 100,
      pointsGained: 100,
      unlockedKeys: [],
    },
    replayed,
  };
}

class Candidates implements BattleRewardCandidateSource {
  public constructor(private readonly ids: readonly string[]) {}
  public async listPendingBattleIds(limit: number): Promise<readonly string[]> {
    return this.ids.slice(0, limit);
  }
}

class Executor implements BattleRewardExecutor {
  public readonly calls: {
    battleId: string;
    idempotencyKey: string;
    correlationId: string;
  }[] = [];

  public constructor(
    private readonly results: ReadonlyMap<string, ProgressionResult<BattleRewardResult>>,
  ) {}

  public async applyBattleReward(input: {
    readonly battleId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ProgressionResult<BattleRewardResult>> {
    this.calls.push(input);
    const result = this.results.get(input.battleId);
    if (result === undefined) throw new Error("missing fake result");
    return result;
  }
}

describe("automatic battle reward worker", () => {
  it("applies and replays pending rewards with deterministic battle keys", async () => {
    const executor = new Executor(
      new Map([
        [BATTLE_A, { ok: true, value: reward(BATTLE_A, false) }],
        [BATTLE_B, { ok: true, value: reward(BATTLE_B, true) }],
      ]),
    );
    const worker = new BattleRewardWorker(new Candidates([BATTLE_A, BATTLE_B]), executor, 10);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 2,
      applied: 1,
      replayed: 1,
      failed: 0,
    });
    expect(executor.calls).toEqual([
      {
        battleId: BATTLE_A,
        idempotencyKey: `automatic-battle-reward:${BATTLE_A}`,
        correlationId: BATTLE_A,
      },
      {
        battleId: BATTLE_B,
        idempotencyKey: `automatic-battle-reward:${BATTLE_B}`,
        correlationId: BATTLE_B,
      },
    ]);
  });

  it("isolates a failed reward and continues the batch", async () => {
    const executor = new Executor(
      new Map([
        [
          BATTLE_A,
          {
            ok: false,
            error: {
              code: "BATTLE_REWARD_NOT_ELIGIBLE",
              message: "not eligible",
              details: {},
            },
          },
        ],
        [BATTLE_B, { ok: true, value: reward(BATTLE_B, false) }],
      ]),
    );
    const worker = new BattleRewardWorker(new Candidates([BATTLE_A, BATTLE_B]), executor);

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 2,
      applied: 1,
      replayed: 0,
      failed: 1,
    });
  });
});
