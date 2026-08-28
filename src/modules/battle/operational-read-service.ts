import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { BattleAction, BattleState } from "./contracts.js";
import { legalActionsForSide } from "./legal.js";
import type { BattleRepository } from "./ports.js";
import { normalizeBattleRules } from "./rules.js";

export interface OperationalBattleView {
  readonly state: BattleState;
  readonly playerSideNo: number;
  readonly legalActions: readonly BattleAction[];
}

export class BattleOperationalReadService {
  public constructor(private readonly repository: BattleRepository) {}

  public async forPlayer(
    battleId: string,
    playerId: string,
  ): Promise<Result<OperationalBattleView>> {
    return this.repository.read(async (transaction) => {
      const root = await transaction.loadRoot(battleId);
      if (root === null) return err(appError("NOT_FOUND", "Battle was not found"));
      const state = await transaction.loadState(battleId, root.version);
      if (state === null) return err(appError("ACTION_INVALID", "Battle has no current state"));
      const side = state.sides.find(
        (candidate) => candidate.controllerKind === "PLAYER" && candidate.playerId === playerId,
      );
      if (side === undefined)
        return err(appError("ACTION_INVALID", "Player is not a participant in this battle"));
      const ruleset = await transaction.loadRuleset(root.rulesetId);
      if (ruleset === null)
        return err(appError("FEATURE_UNAVAILABLE", "Battle ruleset is unavailable"));
      const rules = normalizeBattleRules(ruleset);
      if (!rules.ok) return err(appError("FEATURE_UNAVAILABLE", "Battle ruleset is invalid"));
      return ok({
        state,
        playerSideNo: side.sideNo,
        legalActions: legalActionsForSide(state, side.sideNo, rules.value),
      });
    });
  }
}
