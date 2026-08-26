import type { BattleAction, BattleCombatant, BattleError, BattleState } from "./contracts.js";
import type { BattleRules } from "./rules.js";

function combatant(state: BattleState, participantId: string): BattleCombatant | undefined {
  return state.combatants.find((entry) => entry.participantId === participantId);
}

export function activeCombatant(state: BattleState, sideNo: number): BattleCombatant | undefined {
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  return side === undefined ? undefined : combatant(state, side.activeParticipantId);
}

function opponentActive(state: BattleState, sideNo: number): BattleCombatant | undefined {
  const side = state.sides.find((entry) => entry.sideNo !== sideNo && entry.result === null);
  return side === undefined ? undefined : combatant(state, side.activeParticipantId);
}

export function usableReserves(state: BattleState, sideNo: number): readonly BattleCombatant[] {
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  if (side === undefined) return [];
  return side.participantIds
    .filter((id) => id !== side.activeParticipantId)
    .map((id) => combatant(state, id))
    .filter((entry): entry is BattleCombatant => entry !== undefined && entry.currentHp > 0);
}

export function legalActionsForSide(
  state: BattleState,
  sideNo: number,
  rules: BattleRules,
): readonly BattleAction[] {
  if (state.status !== "ACTIVE") return [];
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  const actor = activeCombatant(state, sideNo);
  if (side === undefined || actor === undefined) return [];

  const switches: BattleAction[] = usableReserves(state, sideNo).map((reserve) => ({
    type: "SWITCH",
    actorParticipantId: actor.participantId,
    switchToParticipantId: reserve.participantId,
  }));
  if (actor.currentHp <= 0) return switches;

  const target = opponentActive(state, sideNo);
  const actions: BattleAction[] = [];
  if (target !== undefined && target.currentHp > 0) {
    for (const move of actor.moves) {
      if (!rules.ppEnabled || move.ppCurrent === null || move.ppCurrent > 0) {
        actions.push({
          type: "USE_MOVE",
          actorParticipantId: actor.participantId,
          moveSlot: move.slotNo,
          targetParticipantId: target.participantId,
        });
      }
    }
  }
  actions.push(...switches);
  if (
    side.controllerKind === "PLAYER" &&
    (state.battleType === "WILD" || state.battleType === "NPC")
  ) {
    actions.push({ type: "FLEE", actorParticipantId: actor.participantId });
  }
  return actions;
}

function sameAction(left: BattleAction, right: BattleAction): boolean {
  if (left.type !== right.type || left.actorParticipantId !== right.actorParticipantId)
    return false;
  if (left.type === "USE_MOVE" && right.type === "USE_MOVE") {
    return (
      left.moveSlot === right.moveSlot && left.targetParticipantId === right.targetParticipantId
    );
  }
  if (left.type === "SWITCH" && right.type === "SWITCH") {
    return left.switchToParticipantId === right.switchToParticipantId;
  }
  if (left.type === "USE_ITEM" && right.type === "USE_ITEM") {
    return left.itemId === right.itemId && left.targetParticipantId === right.targetParticipantId;
  }
  return left.type === "FLEE" && right.type === "FLEE";
}

export function validateBattleAction(
  state: BattleState,
  action: BattleAction,
  rules: BattleRules,
): BattleError | null {
  const actor = combatant(state, action.actorParticipantId);
  if (actor === undefined) {
    return { code: "BATTLE_ACTION_INVALID", message: "Actor participant is absent from battle" };
  }
  const legal = legalActionsForSide(state, actor.sideNo, rules);
  if (!legal.some((candidate) => sameAction(candidate, action))) {
    return {
      code: "BATTLE_ACTION_INVALID",
      message: "Action is not legal in the current battle state",
      details: { actionType: action.type, sideNo: actor.sideNo },
    };
  }
  return null;
}
