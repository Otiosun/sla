import type { Pool } from "pg";
import { AutoTurnDispatcher } from "../modules/battle/auto-turn-dispatcher.js";
import { PvpTurnResolutionService } from "../modules/battle/pvp-turn-resolution.js";
import { BattleRuntimeService } from "../modules/battle/runtime.js";
import { BattleService } from "../modules/battle/service.js";
import { PostgresAutoTurnWindowReader } from "../platform/battle/postgres-auto-turn-window-reader.js";
import { PostgresBattleAftermath } from "../platform/battle/postgres-battle-aftermath.js";
import { PostgresBattleCancellation } from "../platform/battle/postgres-battle-cancellation.js";
import { PostgresBattleRepository } from "../platform/battle/postgres-battle-repository.js";
import { PostgresPvpTurnResolutionRepository } from "../platform/battle/postgres-pvp-turn-resolution-repository.js";
import { AesBattleSeedReader } from "../platform/rng/battle-seed-reader.js";

export interface PveBattleRuntimeConfig {
  readonly turnWindowTtlMs: number;
  readonly maintenanceBatchSize: number;
  readonly encryptionKeys: ReadonlyMap<number, Uint8Array>;
}

/** Explicit opt-in: existing active legacy battles keep their original orchestration. */
export function createPveBattleRuntime(pool: Pool, config: PveBattleRuntimeConfig) {
  if (!Number.isSafeInteger(config.maintenanceBatchSize) || config.maintenanceBatchSize < 1) {
    throw new Error("PVE maintenance batch size must be a positive safe integer");
  }
  const repository = new PostgresBattleRepository(pool, {
    turnWindowTtlMs: config.turnWindowTtlMs,
  });
  const seeds = new AesBattleSeedReader(config.encryptionKeys);
  const aftermath = new PostgresBattleAftermath(pool);
  const battle = new BattleRuntimeService(
    new BattleService(repository, seeds),
    aftermath,
    new PostgresBattleCancellation(pool),
  );
  const dispatcher = new AutoTurnDispatcher(
    new PostgresAutoTurnWindowReader(pool),
    new PvpTurnResolutionService(new PostgresPvpTurnResolutionRepository(pool), seeds),
  );
  return {
    battle,
    runMaintenance: async () => {
      const turns = await dispatcher.runOnce({ limit: config.maintenanceBatchSize });
      const defeats = await aftermath.runOnce(config.maintenanceBatchSize);
      return { turns, defeats };
    },
  };
}
