import type { BattleRewardResult } from "./contracts.js";
import type { ProgressionResult } from "./errors.js";

export interface BattleRewardCandidateSource {
  listPendingBattleIds(limit: number): Promise<readonly string[]>;
}

export interface BattleRewardExecutor {
  applyBattleReward(input: {
    readonly battleId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<ProgressionResult<BattleRewardResult>>;
}

export interface BattleRewardWorkerRunResult {
  readonly claimed: number;
  readonly applied: number;
  readonly replayed: number;
  readonly failed: number;
}

export class BattleRewardWorker {
  public constructor(
    private readonly candidates: BattleRewardCandidateSource,
    private readonly executor: BattleRewardExecutor,
    private readonly batchSize = 25,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error("Battle reward batch size must be a positive safe integer");
    }
  }

  public async runOnce(): Promise<BattleRewardWorkerRunResult> {
    const battleIds = await this.candidates.listPendingBattleIds(this.batchSize);
    let applied = 0;
    let replayed = 0;
    let failed = 0;

    for (const battleId of battleIds) {
      try {
        const result = await this.executor.applyBattleReward({
          battleId,
          idempotencyKey: `automatic-battle-reward:${battleId}`,
          correlationId: battleId,
        });
        if (!result.ok) {
          failed += 1;
          continue;
        }
        if (result.value.replayed) replayed += 1;
        else applied += 1;
      } catch {
        failed += 1;
      }
    }

    return { claimed: battleIds.length, applied, replayed, failed };
  }
}
