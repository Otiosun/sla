import type { Clock } from "../../platform/clock/index.js";
import { encounterRepositoryWithinTransaction } from "../../platform/encounter/postgres-encounter-repository.js";
import type { PostgresExpeditionRepository } from "../../platform/exploration/postgres-expedition-repository.js";
import type { EncounterSeedProvider } from "../encounter/ports.js";
import { EncounterService } from "../encounter/service.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import type { EncounterId, PlayerId } from "../../shared-kernel/ids.js";

/**
 * Only for isolated offline tests. The repository owns a single transaction
 * with expedition time/receipt while the canonical EncounterService performs
 * the actual flee. This adapter is never registered in the live WhatsApp bot.
 */
export class ExpeditionIncidentalIgnoreStagingAction {
  public constructor(
    private readonly expeditions: Pick<PostgresExpeditionRepository, "executeIgnoreIncidental">,
    private readonly seedProvider: EncounterSeedProvider,
    private readonly clock: Clock,
    private readonly feature: FeatureAvailability,
  ) {}

  public execute(input: {
    readonly playerId: PlayerId;
    readonly outcomeId: string;
    readonly encounterId: EncounterId;
    readonly expectedEncounterRevision: bigint;
    readonly idempotencyKey: string;
  }) {
    return this.expeditions.executeIgnoreIncidental({
      ...input,
      flee: (client) =>
        new EncounterService(
          encounterRepositoryWithinTransaction(client),
          this.seedProvider,
          this.clock,
          this.feature,
        ).flee({
          playerId: input.playerId,
          encounterId: input.encounterId,
          expectedRevision: input.expectedEncounterRevision,
        }),
    });
  }
}
