import { err, ok, type Result } from "../../shared-kernel/result.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import type { EncounterView } from "./contracts.js";
import { encounterNotFound, encounterNotReady } from "./errors.js";
import type { EncounterRepository } from "./ports.js";

export class EncounterOperationalReadService {
  public constructor(private readonly repository: EncounterRepository) {}

  public async activeForPlayer(playerId: PlayerId): Promise<Result<EncounterView>> {
    return this.repository.read(async (transaction) => {
      const encounter = await transaction.activeForPlayer(playerId);
      if (encounter === null) return err(encounterNotFound("Player has no active encounter"));
      const snapshot = await transaction.snapshot(encounter.encounterId);
      if (snapshot === null) return err(encounterNotReady("Active encounter snapshot is missing"));
      const battleId = await transaction.battleId(encounter.encounterId);
      return ok({ ...encounter, snapshot, battleId });
    });
  }
}
