import type { EconomyService } from "../economy/service.js";
import type { ProgressionService } from "../progression/service.js";
import type { CompetitiveSpawnRewardDescriptor } from "./reward.js";

export interface CompetitiveSpawnRewardApplicationInput {
  readonly playerId: string;
  readonly spawnId: string;
  readonly correlationId: string;
  readonly reward: CompetitiveSpawnRewardDescriptor;
}

export interface CompetitiveSpawnRewardApplicationPort {
  apply(input: CompetitiveSpawnRewardApplicationInput): Promise<void>;
}

export class CompetitiveSpawnRewardApplicationService
  implements CompetitiveSpawnRewardApplicationPort
{
  public constructor(
    private readonly economy: Pick<EconomyService, "addItem" | "creditWallet">,
    private readonly progression: Pick<ProgressionService, "adjustTrainerProgress">,
  ) {}

  public async apply(input: CompetitiveSpawnRewardApplicationInput): Promise<void> {
    const idempotencyKey = `competitive-spawn:${input.spawnId}:base-reward`;
    const metadata = {
      sourceType: "COMPETITIVE_SPAWN",
      sourceId: input.spawnId,
      reason: "competitive-spawn-identification-reward",
      actorType: "SYSTEM" as const,
      actorId: null,
      correlationId: input.correlationId,
    };

    if (input.reward.kind === "MONEY") {
      if (input.reward.currencyId === null)
        throw new Error("Competitive money reward has no currency");
      const result = await this.economy.creditWallet({
        playerId: input.playerId as never,
        currencyId: input.reward.currencyId,
        amount: BigInt(input.reward.amount),
        idempotencyKey,
        metadata,
      });
      if (!result.ok) throw new Error(`COMPETITIVE_REWARD_MONEY_${result.error.code}`);
      return;
    }

    if (input.reward.kind === "ITEM") {
      if (input.reward.itemId === null) throw new Error("Competitive item reward has no item");
      const result = await this.economy.addItem({
        playerId: input.playerId as never,
        itemId: input.reward.itemId,
        quantity: BigInt(input.reward.amount),
        idempotencyKey,
        metadata,
      });
      if (!result.ok) throw new Error(`COMPETITIVE_REWARD_ITEM_${result.error.code}`);
      return;
    }

    const result = await this.progression.adjustTrainerProgress({
      playerId: input.playerId,
      delta: input.reward.amount,
      idempotencyKey,
      correlationId: input.correlationId,
      metadata: {
        sourceType: "COMPETITIVE_SPAWN",
        sourceId: input.spawnId,
        reason: "competitive-spawn-identification-reward",
        actorType: "SYSTEM",
        actorId: null,
      },
    });
    if (!result.ok) throw new Error(`COMPETITIVE_REWARD_PROGRESSION_${result.error.code}`);
  }
}
