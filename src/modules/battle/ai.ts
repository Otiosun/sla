import type { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import type { BattleAction, BattleState } from "./contracts.js";
import { legalActionsForSide } from "./legal.js";
import type { BattleRules } from "./rules.js";
import { typeEffectivenessBasisPoints } from "./rules.js";

function scoreMove(
  state: BattleState,
  action: Extract<BattleAction, { type: "USE_MOVE" }>,
  rules: BattleRules,
): number {
  const actor = state.combatants.find((entry) => entry.participantId === action.actorParticipantId);
  const target = state.combatants.find(
    (entry) => entry.participantId === action.targetParticipantId,
  );
  const move = actor?.moves.find((entry) => entry.slotNo === action.moveSlot);
  if (actor === undefined || target === undefined || move === undefined) return -1;
  const defendingTypes = [target.type1Id, ...(target.type2Id === null ? [] : [target.type2Id])];
  const effectiveness = typeEffectivenessBasisPoints(rules, move.typeId, defendingTypes);
  const power = move.power ?? 0;
  return power * Math.max(1, effectiveness) + move.priority;
}

export function chooseHeuristicAction(
  state: BattleState,
  sideNo: number,
  rules: BattleRules,
  rng: CounterRandomSource,
): BattleAction | null {
  const legal = legalActionsForSide(state, sideNo, rules).filter(
    (action) => action.type !== "FLEE",
  );
  if (legal.length === 0) return null;
  const scored = legal.map((action) => ({
    action,
    score:
      action.type === "USE_MOVE"
        ? scoreMove(state, action, rules)
        : action.type === "SWITCH"
          ? 1
          : 0,
  }));
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  return best[rng.randomInt(best.length)]?.action ?? null;
}
