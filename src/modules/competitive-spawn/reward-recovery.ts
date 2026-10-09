import type { CompetitiveSpawnRewardDescriptor } from "./reward.js";
import type { CompetitiveSpawnRewardApplicationPort } from "./reward-application.js";

export interface CompetitiveSpawnRewardRecoveryIntent {
  readonly spawnId: string;
  readonly playerId: string;
  readonly correlationId: string;
  readonly reward: CompetitiveSpawnRewardDescriptor;
  readonly attempts: number;
}

export interface CompetitiveSpawnRewardRecoveryRepository {
  claimPending(input: {
    readonly now: Date;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly CompetitiveSpawnRewardRecoveryIntent[]>;
  markApplied(spawnId: string, now: Date): Promise<void>;
  markFailed(input: {
    readonly spawnId: string;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void>;
  projectAppliedWinners(limit: number, now: Date): Promise<number>;
}

export interface CompetitiveSpawnRewardRecoveryRunResult {
  readonly claimed: number;
  readonly applied: number;
  readonly failed: number;
  readonly projected: number;
}

function retryAt(
  attempts: number,
  now: Date,
  maxAttempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): Date | null {
  if (attempts >= maxAttempts) return null;
  const exponent = Math.max(0, attempts - 1);
  const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(exponent, 20));
  return new Date(now.getTime() + delay);
}

export class CompetitiveSpawnRewardRecoveryWorker {
  public constructor(
    private readonly repository: CompetitiveSpawnRewardRecoveryRepository,
    private readonly application: CompetitiveSpawnRewardApplicationPort,
    private readonly options: {
      readonly batchSize: number;
      readonly leaseMs: number;
      readonly maxAttempts: number;
      readonly baseBackoffMs: number;
      readonly maxBackoffMs: number;
    } = {
      batchSize: 25,
      leaseMs: 30_000,
      maxAttempts: 10,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async runOnce(): Promise<CompetitiveSpawnRewardRecoveryRunResult> {
    const pending = await this.repository.claimPending({
      now: this.now(),
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });
    let applied = 0;
    let failed = 0;

    for (const intent of pending) {
      try {
        await this.application.apply({
          playerId: intent.playerId,
          spawnId: intent.spawnId,
          correlationId: intent.correlationId,
          reward: intent.reward,
        });
        await this.repository.markApplied(intent.spawnId, this.now());
        applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "UNKNOWN_REWARD_APPLICATION_ERROR";
        await this.repository.markFailed({
          spawnId: intent.spawnId,
          now: this.now(),
          errorCode: message.slice(0, 500),
          retryAt: retryAt(
            intent.attempts,
            this.now(),
            this.options.maxAttempts,
            this.options.baseBackoffMs,
            this.options.maxBackoffMs,
          ),
          maxAttempts: this.options.maxAttempts,
        });
        failed += 1;
      }
    }

    const projected = await this.repository.projectAppliedWinners(
      this.options.batchSize,
      this.now(),
    );
    return { claimed: pending.length, applied, failed, projected };
  }
}
