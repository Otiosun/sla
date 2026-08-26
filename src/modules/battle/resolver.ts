import { EffectConfigSchemas } from "../catalog/contracts.js";
import type { CounterRandomSource } from "../../platform/rng/counter-rng.js";
import {
  BattleActionSchema,
  BattleStateSchema,
  type BattleAction,
  type BattleCombatant,
  type BattleError,
  type BattleEvent,
  type BattleSide,
  type BattleState,
  type BattleStatKey,
  type ResolvedTurn,
} from "./contracts.js";
import { computeDamage } from "./damage.js";
import { activeCombatant, usableReserves, validateBattleAction } from "./legal.js";
import type { BattleRules } from "./rules.js";
import { statusCounterOnApply } from "./rules.js";
import {
  effectiveAccuracyPercent,
  effectiveDefense,
  effectiveOffense,
  effectiveSpeed,
} from "./stats.js";

export type ResolveTurnResult =
  | { readonly ok: true; readonly value: ResolvedTurn }
  | { readonly ok: false; readonly error: BattleError };

function event(type: BattleEvent["type"], payload: Readonly<Record<string, unknown>>): BattleEvent {
  return { type, payload };
}

function findCombatant(state: BattleState, id: string): BattleCombatant {
  const found = state.combatants.find((entry) => entry.participantId === id);
  if (found === undefined) throw new Error(`Battle state lost combatant ${id}`);
  return found;
}

function findSide(state: BattleState, sideNo: number): BattleSide {
  const found = state.sides.find((entry) => entry.sideNo === sideNo);
  if (found === undefined) throw new Error(`Battle state lost side ${sideNo}`);
  return found;
}

function requiredActionSides(state: BattleState): readonly number[] {
  const forced = state.sides
    .filter((side) => {
      const active = activeCombatant(state, side.sideNo);
      return (
        active !== undefined &&
        active.currentHp <= 0 &&
        usableReserves(state, side.sideNo).length > 0
      );
    })
    .map((side) => side.sideNo);
  return forced.length > 0
    ? forced
    : state.sides.filter((side) => side.result === null).map((side) => side.sideNo);
}

function actionPriority(state: BattleState, action: BattleAction): number {
  if (action.type === "FLEE") return 100;
  if (action.type === "SWITCH") return 90;
  if (action.type === "USE_ITEM") return 80;
  const actor = findCombatant(state, action.actorParticipantId);
  return actor.moves.find((move) => move.slotNo === action.moveSlot)?.priority ?? -100;
}

function orderedActions(
  state: BattleState,
  actions: readonly BattleAction[],
  rules: BattleRules,
  rng: CounterRandomSource,
): readonly BattleAction[] {
  const decorated = actions.map((action, index) => {
    const actor = findCombatant(state, action.actorParticipantId);
    return {
      action,
      index,
      priority: actionPriority(state, action),
      speed: effectiveSpeed(actor, rules),
      tie: 0,
    };
  });
  const groups = new Map<string, typeof decorated>();
  for (const entry of decorated) {
    const key = `${entry.priority}:${entry.speed}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    for (const entry of group) entry.tie = rng.randomInt(1_000_000);
  }
  return decorated
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.speed - left.speed ||
        right.tie - left.tie ||
        left.index - right.index,
    )
    .map((entry) => entry.action);
}

function clampStage(value: number): number {
  return Math.max(-6, Math.min(6, value));
}

function stageProperty(stat: BattleStatKey): keyof BattleCombatant["stages"] {
  switch (stat) {
    case "ATTACK":
      return "attack";
    case "DEFENSE":
      return "defense";
    case "SP_ATTACK":
      return "spAttack";
    case "SP_DEFENSE":
      return "spDefense";
    case "SPEED":
      return "speed";
    case "ACCURACY":
      return "accuracy";
    case "EVASION":
      return "evasion";
  }
}

function emitFaintIfNeeded(
  combatant: BattleCombatant,
  previousHp: number,
  events: BattleEvent[],
): void {
  if (previousHp > 0 && combatant.currentHp === 0) {
    events.push(
      event("Fainted", { participantId: combatant.participantId, sideNo: combatant.sideNo }),
    );
  }
}

function applyStatus(
  target: BattleCombatant,
  status: "BURN" | "POISON" | "PARALYSIS" | "SLEEP" | "FREEZE",
  chanceBasisPoints: number,
  rules: BattleRules,
  rng: CounterRandomSource,
  events: BattleEvent[],
  source: Readonly<Record<string, unknown>>,
): void {
  if (target.currentHp <= 0 || target.majorStatus !== null) return;
  if (rng.randomInt(10_000) >= chanceBasisPoints) return;
  target.majorStatus = {
    key: status,
    counter: statusCounterOnApply(status, (maxExclusive) => rng.randomInt(maxExclusive), rules),
  };
  events.push(event("StatusApplied", { participantId: target.participantId, status, ...source }));
}

function applyMoveEffect(
  defender: BattleCombatant,
  move: BattleCombatant["moves"][number],
  rules: BattleRules,
  rng: CounterRandomSource,
  events: BattleEvent[],
): void {
  if (move.effectKey === "apply-status") {
    const parsed = EffectConfigSchemas["apply-status"].safeParse(move.effectConfig);
    if (parsed.success) {
      applyStatus(defender, parsed.data.status, parsed.data.chanceBasisPoints, rules, rng, events, {
        source: "MOVE",
        moveId: move.moveId,
      });
    }
    return;
  }
  if (move.effectKey !== "modify-stat-stage") return;
  const parsed = EffectConfigSchemas["modify-stat-stage"].safeParse(move.effectConfig);
  if (!parsed.success || defender.currentHp <= 0) return;
  if (
    parsed.data.stat === "ACCURACY" &&
    parsed.data.stages < 0 &&
    defender.ability.effectKey === "prevent-accuracy-drop"
  ) {
    events.push(
      event("AbilityTriggered", {
        participantId: defender.participantId,
        abilityId: defender.ability.abilityId,
        effectKey: defender.ability.effectKey,
      }),
    );
    return;
  }
  const key = stageProperty(parsed.data.stat);
  const before = defender.stages[key];
  const after = clampStage(before + parsed.data.stages);
  defender.stages[key] = after;
  if (after !== before) {
    events.push(
      event("StatStageChanged", {
        participantId: defender.participantId,
        stat: parsed.data.stat,
        from: before,
        to: after,
        moveId: move.moveId,
      }),
    );
  }
}

function applyContactAbility(
  attacker: BattleCombatant,
  defender: BattleCombatant,
  move: BattleCombatant["moves"][number],
  rules: BattleRules,
  rng: CounterRandomSource,
  events: BattleEvent[],
): void {
  if (!move.flags.makesContact) return;
  if (defender.ability.effectKey !== "apply-status-on-contact-received") return;
  const parsed = EffectConfigSchemas["apply-status-on-contact-received"].safeParse(
    defender.ability.effectConfig,
  );
  if (!parsed.success) return;
  const before = attacker.majorStatus;
  applyStatus(attacker, parsed.data.status, parsed.data.chanceBasisPoints, rules, rng, events, {
    source: "ABILITY",
    abilityId: defender.ability.abilityId,
  });
  if (before === null && attacker.majorStatus !== null) {
    events.push(
      event("AbilityTriggered", {
        participantId: defender.participantId,
        abilityId: defender.ability.abilityId,
        effectKey: defender.ability.effectKey,
      }),
    );
  }
}

function accuracyHits(
  attacker: BattleCombatant,
  defender: BattleCombatant,
  accuracy: number | null,
  rules: BattleRules,
  rng: CounterRandomSource,
): boolean {
  if (accuracy === null) return true;
  const effective = effectiveAccuracyPercent(
    accuracy,
    attacker.stages,
    defender.stages,
    rules.accuracyEvasionEnabled,
  );
  return rng.randomInt(10_000) < Math.floor(effective * 100);
}

function confusionDamage(
  combatant: BattleCombatant,
  rules: BattleRules,
  rng: CounterRandomSource,
): number {
  const attack = effectiveOffense(combatant, "PHYSICAL", rules);
  const defense = Math.max(1, effectiveDefense(combatant, "PHYSICAL", rules));
  const levelFactor = Math.floor((2 * combatant.level) / 5) + 2;
  const base = Math.floor(Math.floor((levelFactor * 40 * attack) / defense) / 50) + 2;
  const width = rules.damageRandomMaxBasisPoints - rules.damageRandomMinBasisPoints + 1;
  const randomBp = rules.damageRandomMinBasisPoints + rng.randomInt(width);
  return Math.max(1, Math.floor((base * randomBp) / 10_000));
}

function canUseMove(
  actor: BattleCombatant,
  rules: BattleRules,
  rng: CounterRandomSource,
  events: BattleEvent[],
): boolean {
  if (actor.volatile.flinch) {
    actor.volatile.flinch = false;
    events.push(event("ActionBlocked", { participantId: actor.participantId, reason: "FLINCH" }));
    return false;
  }
  if (actor.volatile.confusionTurns > 0) {
    actor.volatile.confusionTurns -= 1;
    if (rng.randomInt(10_000) < rules.status.confusionSelfHitChanceBasisPoints) {
      const previousHp = actor.currentHp;
      const damage = Math.min(actor.currentHp, confusionDamage(actor, rules, rng));
      actor.currentHp -= damage;
      events.push(
        event("DamageApplied", {
          participantId: actor.participantId,
          damage,
          remainingHp: actor.currentHp,
          source: "CONFUSION",
        }),
      );
      emitFaintIfNeeded(actor, previousHp, events);
      events.push(
        event("ActionBlocked", { participantId: actor.participantId, reason: "CONFUSION" }),
      );
      return false;
    }
  }
  const status = actor.majorStatus;
  if (status === null) return true;
  if (status.key === "PARALYSIS") {
    if (rng.randomInt(10_000) < rules.status.paralysisBlockChanceBasisPoints) {
      events.push(
        event("ActionBlocked", { participantId: actor.participantId, reason: "PARALYSIS" }),
      );
      return false;
    }
    return true;
  }
  if (status.key === "SLEEP") {
    const counter = status.counter ?? 1;
    if (counter <= 1) {
      actor.majorStatus = null;
      events.push(event("StatusCleared", { participantId: actor.participantId, status: "SLEEP" }));
      return true;
    }
    status.counter = counter - 1;
    events.push(event("ActionBlocked", { participantId: actor.participantId, reason: "SLEEP" }));
    return false;
  }
  if (status.key === "FREEZE") {
    if (rng.randomInt(10_000) < rules.status.freezeThawChanceBasisPoints) {
      actor.majorStatus = null;
      events.push(event("StatusCleared", { participantId: actor.participantId, status: "FREEZE" }));
      return true;
    }
    events.push(event("ActionBlocked", { participantId: actor.participantId, reason: "FREEZE" }));
    return false;
  }
  return true;
}

function terminalStatus(state: BattleState): "WON" | "LOST" | "DRAW" | null {
  const living = state.sides.map((side) =>
    side.participantIds.some((id) => findCombatant(state, id).currentHp > 0),
  );
  if (living.every((entry) => !entry)) return "DRAW";
  if (living.length < 2) return null;
  if (!living[0]) return "LOST";
  if (living.slice(1).every((entry) => !entry)) return "WON";
  return null;
}

function finishBattle(
  state: BattleState,
  status: "WON" | "LOST" | "DRAW",
  events: BattleEvent[],
): void {
  state.status = status;
  if (status === "DRAW") {
    for (const side of state.sides) side.result = "DRAW";
  } else {
    const sideOneWon = status === "WON";
    for (const side of state.sides) {
      const won = side.sideNo === 1 ? sideOneWon : !sideOneWon;
      side.result = won ? "WON" : "LOST";
    }
  }
  events.push(event("BattleEnded", { status }));
}

function checkTerminal(state: BattleState, events: BattleEvent[]): boolean {
  const status = terminalStatus(state);
  if (status === null) return false;
  finishBattle(state, status, events);
  return true;
}

function residualDamage(state: BattleState, rules: BattleRules, events: BattleEvent[]): void {
  for (const side of state.sides) {
    const active = findCombatant(state, side.activeParticipantId);
    if (active.currentHp <= 0 || active.majorStatus === null) continue;
    const divisor =
      active.majorStatus.key === "BURN"
        ? rules.status.burnResidualDivisor
        : active.majorStatus.key === "POISON"
          ? rules.status.poisonResidualDivisor
          : null;
    if (divisor === null) continue;
    const previousHp = active.currentHp;
    const damage = Math.min(active.currentHp, Math.max(1, Math.floor(active.maxHp / divisor)));
    active.currentHp -= damage;
    events.push(
      event("DamageApplied", {
        participantId: active.participantId,
        damage,
        remainingHp: active.currentHp,
        source: active.majorStatus.key,
      }),
    );
    emitFaintIfNeeded(active, previousHp, events);
  }
}

function executeMove(
  state: BattleState,
  action: Extract<BattleAction, { type: "USE_MOVE" }>,
  rules: BattleRules,
  rng: CounterRandomSource,
  events: BattleEvent[],
): void {
  const actor = findCombatant(state, action.actorParticipantId);
  const target = findCombatant(state, action.targetParticipantId);
  const move = actor.moves.find((entry) => entry.slotNo === action.moveSlot);
  if (move === undefined) throw new Error("Validated move action lost its move slot");
  if (rules.ppEnabled && move.ppCurrent !== null) move.ppCurrent = Math.max(0, move.ppCurrent - 1);
  events.push(
    event("MoveUsed", {
      participantId: actor.participantId,
      targetParticipantId: target.participantId,
      moveId: move.moveId,
      moveSlot: move.slotNo,
      ppCurrent: move.ppCurrent,
    }),
  );
  if (!accuracyHits(actor, target, move.accuracy, rules, rng)) {
    events.push(
      event("MoveMissed", {
        participantId: actor.participantId,
        targetParticipantId: target.participantId,
        moveId: move.moveId,
      }),
    );
    return;
  }

  let immune = false;
  if (move.category !== "STATUS" && move.power !== null && move.power > 0) {
    const result = computeDamage(actor, target, move, rules, rng);
    immune = result.effectivenessBasisPoints === 0;
    const previousHp = target.currentHp;
    const damage = Math.min(target.currentHp, result.damage);
    target.currentHp -= damage;
    events.push(
      event("DamageApplied", {
        participantId: target.participantId,
        sourceParticipantId: actor.participantId,
        moveId: move.moveId,
        damage,
        remainingHp: target.currentHp,
        critical: result.critical,
        effectivenessBasisPoints: result.effectivenessBasisPoints,
        stabApplied: result.stabApplied,
        randomBasisPoints: result.randomBasisPoints,
        abilityMultiplierBasisPoints: result.abilityMultiplierBasisPoints,
      }),
    );
    emitFaintIfNeeded(target, previousHp, events);
  }
  if (immune) return;

  applyMoveEffect(target, move, rules, rng, events);
  applyContactAbility(actor, target, move, rules, rng, events);
}

function executeSwitch(
  state: BattleState,
  action: Extract<BattleAction, { type: "SWITCH" }>,
  events: BattleEvent[],
): void {
  const actor = findCombatant(state, action.actorParticipantId);
  const side = findSide(state, actor.sideNo);
  const from = side.activeParticipantId;
  side.activeParticipantId = action.switchToParticipantId;
  events.push(
    event("Switched", {
      sideNo: side.sideNo,
      fromParticipantId: from,
      toParticipantId: action.switchToParticipantId,
    }),
  );
}

function executeFlee(
  state: BattleState,
  action: Extract<BattleAction, { type: "FLEE" }>,
  events: BattleEvent[],
): void {
  const actor = findCombatant(state, action.actorParticipantId);
  if (actor.ability.effectKey === "run-away") {
    events.push(
      event("AbilityTriggered", {
        participantId: actor.participantId,
        abilityId: actor.ability.abilityId,
        effectKey: actor.ability.effectKey,
      }),
    );
  }
  state.status = "FLED";
  for (const side of state.sides) side.result = side.sideNo === actor.sideNo ? "FLED" : "WON";
  events.push(event("BattleEnded", { status: "FLED", fleeingSideNo: actor.sideNo }));
}

export function resolveTurn(
  sourceState: BattleState,
  sourceActions: readonly BattleAction[],
  rules: BattleRules,
  rng: CounterRandomSource,
): ResolveTurnResult {
  const parsedState = BattleStateSchema.safeParse(sourceState);
  if (!parsedState.success) {
    return {
      ok: false,
      error: {
        code: "BATTLE_STATE_INVALID",
        message: "Battle state failed schema validation",
        details: { issues: parsedState.error.issues },
      },
    };
  }
  if (sourceState.status !== "ACTIVE") {
    return { ok: false, error: { code: "BATTLE_NOT_ACTIVE", message: "Battle is not active" } };
  }
  const requiredSides = new Set(requiredActionSides(sourceState));
  const actions: BattleAction[] = [];
  const actedSides = new Set<number>();
  for (const rawAction of sourceActions) {
    const parsedAction = BattleActionSchema.safeParse(rawAction);
    if (!parsedAction.success) {
      return {
        ok: false,
        error: {
          code: "BATTLE_ACTION_INVALID",
          message: "Battle action failed schema validation",
          details: { issues: parsedAction.error.issues },
        },
      };
    }
    const actor = sourceState.combatants.find(
      (entry) => entry.participantId === parsedAction.data.actorParticipantId,
    );
    if (actor === undefined || actedSides.has(actor.sideNo) || !requiredSides.has(actor.sideNo)) {
      return {
        ok: false,
        error: {
          code: "BATTLE_ACTION_INVALID",
          message:
            actor === undefined
              ? "Action actor is missing"
              : actedSides.has(actor.sideNo)
                ? "Side submitted more than one action"
                : "Side must wait for forced switch resolution",
        },
      };
    }
    const invalid = validateBattleAction(sourceState, parsedAction.data, rules);
    if (invalid !== null) return { ok: false, error: invalid };
    actedSides.add(actor.sideNo);
    actions.push(parsedAction.data);
  }
  if (actions.length !== requiredSides.size) {
    return {
      ok: false,
      error: {
        code: "BATTLE_ACTION_INVALID",
        message: "Every side requiring an action must submit exactly one legal action",
        details: { expected: requiredSides.size, actual: actions.length },
      },
    };
  }

  const state = structuredClone(sourceState);
  const events: BattleEvent[] = [event("TurnStarted", { turnNumber: state.turnNumber + 1 })];
  const ordered = orderedActions(state, actions, rules, rng);
  for (const action of ordered) {
    if (state.status !== "ACTIVE") break;
    const actor = findCombatant(state, action.actorParticipantId);
    if (actor.currentHp <= 0 && action.type !== "SWITCH") {
      events.push(
        event("ActionSkipped", { participantId: actor.participantId, reason: "FAINTED" }),
      );
      continue;
    }
    if (action.type === "USE_MOVE" && !canUseMove(actor, rules, rng, events)) {
      if (checkTerminal(state, events)) break;
      continue;
    }
    switch (action.type) {
      case "USE_MOVE":
        executeMove(state, action, rules, rng, events);
        break;
      case "SWITCH":
        executeSwitch(state, action, events);
        break;
      case "FLEE":
        executeFlee(state, action, events);
        break;
      case "USE_ITEM":
        return {
          ok: false,
          error: {
            code: "BATTLE_ACTION_INVALID",
            message: "Item actions are not enabled in Battle Engine v1",
          },
        };
    }
    if (state.status === "ACTIVE" && checkTerminal(state, events)) break;
  }

  if (state.status === "ACTIVE") {
    residualDamage(state, rules, events);
    checkTerminal(state, events);
  }
  state.turnNumber += 1;
  state.version += 1;
  state.rngCounter = rng.counter.toString();
  events.push(
    event("TurnResolved", {
      turnNumber: state.turnNumber,
      battleVersion: state.version,
      status: state.status,
      rngCounter: state.rngCounter,
    }),
  );
  return { ok: true, value: { state, events } };
}
