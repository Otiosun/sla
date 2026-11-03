import type { Clock } from "../clock/index.js";
import { WorldService } from "../../modules/world/service.js";
import { worldRepositoryWithinTransaction } from "../world/postgres-world-repository.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { Result } from "../../shared-kernel/result.js";
import type {
  PostgresExpeditionRepository,
  StoredExpeditionTransition,
} from "./postgres-expedition-repository.js";

/** Offline-only adapter: WorldService and Expedition share the outer PoolClient. */
export class PostgresExpeditionV4StagingTravel {
  public constructor(
    private readonly expedition: Pick<PostgresExpeditionRepository, "executeTravel">,
    private readonly clock: Clock,
  ) {}

  public async execute(input: {
    readonly playerId: PlayerId;
    readonly expeditionId: string;
    readonly expectedRevision: bigint;
    readonly expectedWorldRevision: bigint;
    readonly destinationAreaId: string;
    readonly idempotencyKey: string;
  }): Promise<Result<StoredExpeditionTransition>> {
    return this.expedition.executeTravel({
      ...input,
      travel: (client, travel) =>
        new WorldService(
          worldRepositoryWithinTransaction(client),
          { enabled: true, reason: null },
          this.clock,
        ).travel(travel),
    });
  }
}
