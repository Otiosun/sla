import type { PoolClient } from "pg";
import type { Clock } from "../clock/index.js";
import { encounterRepositoryWithinTransaction } from "../encounter/postgres-encounter-repository.js";
import { EncounterService } from "../../modules/encounter/service.js";
import type { EncounterSeedProvider } from "../../modules/encounter/ports.js";
import type { FeatureAvailability } from "../../shared-kernel/gates.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type { ExpeditionSnapshot } from "../../modules/exploration/expedition-state.js";

/**
 * The encounter-producing arm of a free search, and nothing else.
 *
 * The broader exploration gameplay policy still decides NO_SIGNAL/TRAIL/
 * INCIDENTAL/DIRECT and must authorize an actual encounter before invoking
 * this function. No command route is registered by this adapter.
 *
 * Crucially, EncounterService must share the PoolClient that the expedition
 * action already locked. Its normal standalone repository would otherwise
 * commit an encounter independently of the weekly slot/time receipt.
 */
export function createDirectEncounterEffect(deps: {
  readonly seedProvider: EncounterSeedProvider;
  readonly clock: Clock;
  readonly feature: FeatureAvailability;
}): (
  client: PoolClient,
  expedition: ExpeditionSnapshot,
) => Promise<Result<{ readonly effectRef: string }>> {
  return async (client, expedition) => {
    const id = parsePlayerId(expedition.playerId);
    if (!id.ok) return id;
    const service = new EncounterService(
      encounterRepositoryWithinTransaction(client),
      deps.seedProvider,
      deps.clock,
      deps.feature,
    );
    const encounter = await service.createOrReplay({
      playerId: id.value,
      idempotencyKey: `solo-expedition:${expedition.expeditionId}:search:${expedition.revision.toString()}`,
      environment: {
        timeOfDay: expedition.period,
        surface: "LAND",
      },
    });
    if (!encounter.ok) return encounter;
    return ok({ effectRef: encounter.value.encounterId });
  };
}
