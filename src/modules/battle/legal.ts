import type { BattleAction, BattleCombatant, BattleError, BattleState } from "./contracts.js";
import type { BattleRules } from "./rules.js";

function combatant(state: BattleState, participantId: string): BattleCombatant | undefined {
  return state.combatants.find((entry) => entry.participantId === participantId);
}

export function activeCombatant(state: BattleState, sideNo: number): BattleCombatant | undefined {
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  return side === undefined ? undefined : combatant(state, side.activeParticipantId);
}

export function activeCombatants(state: BattleState, sideNo: number): readonly BattleCombatant[] {
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  if (side === undefined) return [];
  return (side.slots ?? [side])
    .map((slot) => combatant(state, slot.activeParticipantId))
    .filter((entry): entry is BattleCombatant => entry !== undefined);
}

export function usableReserves(
  state: BattleState,
  sideNo: number,
  actorParticipantId?: string,
): readonly BattleCombatant[] {
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  if (side === undefined) return [];
  const actorId = actorParticipantId ?? side.activeParticipantId;
  const slot = (side.slots ?? [side]).find((entry) => entry.activeParticipantId === actorId);
  if (slot === undefined) return [];
  return slot.participantIds
    .filter((id) => id !== actorId)
    .map((id) => combatant(state, id))
    .filter((entry): entry is BattleCombatant => entry !== undefined && entry.currentHp > 0);
}

export function legalActionsForSide(
  state: BattleState,
  sideNo: number,
  rules: BattleRules,
): readonly BattleAction[] {
  return activeCombatants(state, sideNo).flatMap((actor) =>
    legalActionsForParticipant(state, actor.participantId, rules),
  );
}

export function legalActionsForParticipant(
  state: BattleState,
  participantId: string,
  rules: BattleRules,
): readonly BattleAction[] {
  if (state.status !== "ACTIVE") return [];
  const actor = combatant(state, participantId);
  if (actor === undefined) return [];
  const sideNo = actor.sideNo;
  const side = state.sides.find((entry) => entry.sideNo === sideNo);
  if (
    side === undefined ||
    side.result !== null ||
    !activeCombatants(state, sideNo).some((entry) => entry.participantId === participantId)
  )
    return [];

  const switches: BattleAction[] = usableReserves(state, sideNo, participantId).map((reserve) => ({
    type: "SWITCH",
    actorParticipantId: actor.participantId,
    switchToParticipantId: reserve.participantId,
  }));
  if (actor.currentHp <= 0) return switches;

  const targets = state.sides
    .filter((entry) => entry.sideNo !== sideNo && entry.result === null)
    .flatMap((entry) => activeCombatants(state, entry.sideNo))
    .filter((entry) => entry.currentHp > 0);
  const actions: BattleAction[] = [];
  for (const target of targets) {
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
  if (left.type === "CAPTURE_ATTEMPT" && right.type === "CAPTURE_ATTEMPT") {
    return (
      left.ballItemId === right.ballItemId && left.targetParticipantId === right.targetParticipantId
    );
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
  if (action.type === "CAPTURE_ATTEMPT") {
    const actorSide = state.sides.find((entry) => entry.sideNo === actor.sideNo);
    const actorIsActive =
      actorSide !== undefined &&
      (actorSide.slots ?? [actorSide]).some(
        (slot) => slot.activeParticipantId === actor.participantId,
      );
    const target = combatant(state, action.targetParticipantId);
    const targetSide =
      target === undefined
        ? undefined
        : state.sides.find((entry) => entry.sideNo === target.sideNo);
    const targetIsActive =
      target !== undefined &&
      targetSide !== undefined &&
      (targetSide.slots ?? [targetSide]).some(
        (slot) => slot.activeParticipantId === target.participantId,
      );

    if (
      state.status !== "ACTIVE" ||
      state.battleType !== "WILD" ||
      actor.participantKind !== "PLAYER_POKEMON" ||
      actor.currentHp <= 0 ||
      !actorIsActive ||
      target === undefined ||
      target.participantKind !== "WILD_POKEMON" ||
      target.currentHp <= 0 ||
      target.sideNo === actor.sideNo ||
      !targetIsActive
    ) {
      return {
        code: "BATTLE_ACTION_INVALID",
        message: "Capture attempt is not legal in the current battle state",
        details: { actionType: action.type, sideNo: actor.sideNo },
      };
    }
    return null;
  }
  const legal = legalActionsForParticipant(state, actor.participantId, rules);
  if (!legal.some((candidate) => sameAction(candidate, action))) {
    return {
      code: "BATTLE_ACTION_INVALID",
      message: "Action is not legal in the current battle state",
      details: { actionType: action.type, sideNo: actor.sideNo },
    };
  }
  return null;
}
