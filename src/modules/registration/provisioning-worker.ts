import type { PlayerAccessRecord } from "./player-access-ports.js";
import type { Result } from "../../shared-kernel/result.js";

export interface PlayerProvisioningCandidateSource {
  listPendingReviewIds(limit: number): Promise<readonly string[]>;
}

export interface PlayerProvisioningExecutor {
  provisionApprovedPlayer(reviewId: string): Promise<Result<PlayerAccessRecord>>;
}

export interface PlayerProvisioningWorkerRunResult {
  readonly claimed: number;
  readonly activated: number;
  readonly failed: number;
}

export class PlayerProvisioningWorker {
  public constructor(
    private readonly candidates: PlayerProvisioningCandidateSource,
    private readonly provisioning: PlayerProvisioningExecutor,
    private readonly batchSize = 25,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error("Player provisioning worker batch size must be a positive safe integer");
    }
  }

  public async runOnce(): Promise<PlayerProvisioningWorkerRunResult> {
    const reviewIds = await this.candidates.listPendingReviewIds(this.batchSize);
    let activated = 0;
    let failed = 0;

    for (const reviewId of reviewIds) {
      try {
        const result = await this.provisioning.provisionApprovedPlayer(reviewId);
        if (result.ok && result.value.status === "ACTIVE") activated += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    return { claimed: reviewIds.length, activated, failed };
  }
}
