import { describe, expect, it } from "vitest";
import { chooseHeuristicAction } from "../../src/modules/battle/ai.js";
import { computeDamage } from "../../src/modules/battle/damage.js";
import { legalActionsForSide, validateBattleAction } from "../../src/modules/battle/legal.js";
import { resolveTurn } from "../../src/modules/battle/resolver.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { battleState, IDS, playerCombatant, TEST_RULES, wildCombatant } from "./fixtures.js";

const rng = (byte: number, counter = 0n) =>
  new CounterRandomSource(Buffer.alloc(32, byte), counter);

describe("battle effects, abilities and heuristic AI", () => {
  it("applies Static only after a successful contact hit", () => {
    const state = battleState();
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (wild === undefined) throw new Error("fixture incomplete");
    wild.ability = {
      abilityId: IDS.staticAbility,
      effectKey: "apply-status-on-contact-received",
      effectConfig: { status: "PARALYSIS", chanceBasisPoints: 10_000 },
    };
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 1, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 2, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(10),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.state.combatants.find((entry) => entry.participantId === IDS.p1)?.majorStatus
        ?.key,
    ).toBe("PARALYSIS");
    expect(
      result.value.events.some(
        (entry) =>
          entry.type === "AbilityTriggered" && entry.payload.abilityId === IDS.staticAbility,
      ),
    ).toBe(true);
  });

  it("does not treat a non-contact move as contact", () => {
    const state = battleState();
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (wild === undefined) throw new Error("fixture incomplete");
    wild.ability = {
      abilityId: IDS.staticAbility,
      effectKey: "apply-status-on-contact-received",
      effectConfig: { status: "PARALYSIS", chanceBasisPoints: 10_000 },
    };
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 2, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 2, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(11),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.state.combatants.find((entry) => entry.participantId === IDS.p1)?.majorStatus,
    ).toBeNull();
  });

  it("blocks negative Accuracy changes behind Keen Eye", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    const growl = player.moves[3];
    if (growl === undefined) throw new Error("fixture incomplete");
    growl.effectConfig = { stat: "ACCURACY", stages: -1 };
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 2, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(12),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.value.state.combatants.find((entry) => entry.participantId === IDS.p2);
    expect(updated?.stages.accuracy).toBe(0);
    expect(result.value.events.some((entry) => entry.type === "AbilityTriggered")).toBe(true);
  });

  it("executes imported move metadata for status, stat change, flinch and drain", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    player.currentHp = 5;
    player.baseStats.speed = 999;
    wild.baseStats.speed = 1;
    wild.currentHp = wild.maxHp = 100;
    const move = player.moves[0];
    if (move === undefined) throw new Error("fixture incomplete");
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 9001,
      sourceMetaCategoryId: 4,
      ailment: {
        kind: "PARALYSIS",
        chanceBasisPoints: 10_000,
        minTurns: null,
        maxTurns: null,
      },
      statChanges: [{ stat: "DEFENSE", stages: -1, target: "TARGET" }],
      statChanceBasisPoints: 10_000,
      flinchChanceBasisPoints: 10_000,
      drainPercent: 50,
      healingPercent: 0,
    };

    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 1, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(14),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updatedPlayer = result.value.state.combatants.find(
      (entry) => entry.participantId === IDS.p1,
    );
    const updatedWild = result.value.state.combatants.find(
      (entry) => entry.participantId === IDS.p2,
    );
    expect(updatedPlayer?.currentHp).toBeGreaterThan(5);
    expect(updatedWild?.majorStatus?.key).toBe("PARALYSIS");
    expect(updatedWild?.stages.defense).toBe(-1);
    expect(
      result.value.events.some(
        (entry) => entry.type === "ActionBlocked" && entry.payload.reason === "FLINCH",
      ),
    ).toBe(true);
    expect(result.value.events.some((entry) => entry.type === "HpRestored")).toBe(true);
  });

  it("executes recoil from imported move metadata", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    if (player === undefined) throw new Error("fixture incomplete");
    player.baseStats.speed = 999;
    const move = player.moves[0];
    if (move === undefined) throw new Error("fixture incomplete");
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 9002,
      sourceMetaCategoryId: 0,
      ailment: null,
      statChanges: [],
      statChanceBasisPoints: 0,
      flinchChanceBasisPoints: 0,
      drainPercent: -25,
      healingPercent: 0,
    };

    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 1, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(15),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.events.some(
        (entry) => entry.type === "DamageApplied" && entry.payload.source === "RECOIL",
      ),
    ).toBe(true);
  });

  it("executes confusion and percentage healing from imported move metadata", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    player.currentHp = 5;
    player.baseStats.speed = 999;
    const move = player.moves[3];
    if (move === undefined) throw new Error("fixture incomplete");
    move.category = "STATUS";
    move.power = null;
    move.accuracy = null;
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 9003,
      sourceMetaCategoryId: 1,
      ailment: {
        kind: "CONFUSION",
        chanceBasisPoints: 10_000,
        minTurns: 2,
        maxTurns: 5,
      },
      statChanges: [],
      statChanceBasisPoints: 0,
      flinchChanceBasisPoints: 0,
      drainPercent: 0,
      healingPercent: 50,
    };

    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(16),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updatedWild = result.value.state.combatants.find(
      (entry) => entry.participantId === IDS.p2,
    );
    expect(updatedWild?.volatile.confusionTurns).toBeGreaterThanOrEqual(1);
    expect(result.value.events.some((entry) => entry.type === "HpRestored")).toBe(true);
    expect(
      result.value.events.some(
        (entry) => entry.type === "StatusApplied" && entry.payload.status === "CONFUSION",
      ),
    ).toBe(true);
  });

  it("blocks a major status with prevent-status", () => {
    const state = battleState();
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    if (wild === undefined || player === undefined) throw new Error("fixture incomplete");
    wild.ability = {
      abilityId: IDS.keenEye,
      effectKey: "prevent-status",
      effectConfig: { statuses: ["PARALYSIS"] },
    };
    const move = player.moves[3];
    if (move === undefined) throw new Error("fixture incomplete");
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 9101,
      sourceMetaCategoryId: 1,
      ailment: {
        kind: "PARALYSIS",
        chanceBasisPoints: 10_000,
        minTurns: null,
        maxTurns: null,
      },
      statChanges: [],
      statChanceBasisPoints: 0,
      flinchChanceBasisPoints: 0,
      drainPercent: 0,
      healingPercent: 0,
    };

    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(17),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.state.combatants.find((entry) => entry.participantId === IDS.p2)?.majorStatus,
    ).toBeNull();
    expect(
      result.value.events.some(
        (entry) =>
          entry.type === "AbilityTriggered" && entry.payload.preventedCondition === "PARALYSIS",
      ),
    ).toBe(true);
  });

  it("blocks opponent stat drops but not self-inflicted drops", () => {
    const state = battleState();
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (wild === undefined) throw new Error("fixture incomplete");
    wild.ability = {
      abilityId: IDS.keenEye,
      effectKey: "prevent-stat-drop",
      effectConfig: { stats: ["ATTACK", "DEFENSE"] },
    };
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(18),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.value.state.combatants.find((entry) => entry.participantId === IDS.p2);
    expect(updated?.stages.attack).toBe(0);
    expect(
      result.value.events.some(
        (entry) => entry.type === "AbilityTriggered" && entry.payload.preventedStat === "ATTACK",
      ),
    ).toBe(true);
  });

  it("blocks flinch with prevent-flinch", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    player.baseStats.speed = 999;
    wild.baseStats.speed = 1;
    wild.ability = { abilityId: IDS.keenEye, effectKey: "prevent-flinch", effectConfig: {} };
    const move = player.moves[0];
    if (move === undefined) throw new Error("fixture incomplete");
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 9102,
      sourceMetaCategoryId: 0,
      ailment: null,
      statChanges: [],
      statChanceBasisPoints: 0,
      flinchChanceBasisPoints: 10_000,
      drainPercent: 0,
      healingPercent: 0,
    };
    const result = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 1, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(19),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.events.some(
        (entry) => entry.type === "ActionBlocked" && entry.payload.reason === "FLINCH",
      ),
    ).toBe(false);
    expect(
      result.value.events.some(
        (entry) =>
          entry.type === "AbilityTriggered" && entry.payload.preventedCondition === "FLINCH",
      ),
    ).toBe(true);
  });

  it("prevents critical hits with prevent-critical", () => {
    const attacker = playerCombatant();
    const defender = wildCombatant();
    defender.ability = { abilityId: IDS.keenEye, effectKey: "prevent-critical", effectConfig: {} };
    const move = attacker.moves[0];
    if (move === undefined) throw new Error("fixture incomplete");
    const result = computeDamage(
      attacker,
      defender,
      move,
      { ...TEST_RULES, criticalChanceBasisPoints: 10_000 },
      rng(20),
    );
    expect(result.critical).toBe(false);
  });

  it("applies escalating bad-poison residual damage across turns", () => {
    let state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    const wild = state.combatants.find((entry) => entry.participantId === IDS.p2);
    if (player === undefined || wild === undefined) throw new Error("fixture incomplete");
    player.maxHp = player.currentHp = 200;
    player.baseStats.speed = 999;
    wild.maxHp = wild.currentHp = 160;
    wild.baseStats.speed = 1;
    const move = player.moves[3];
    if (move === undefined) throw new Error("fixture incomplete");
    move.category = "STATUS";
    move.power = null;
    move.accuracy = null;
    move.effectKey = "move-meta-v1";
    move.effectConfig = {
      sourceEffectId: 34,
      sourceMetaCategoryId: 1,
      ailment: {
        kind: "BAD_POISON",
        chanceBasisPoints: 10_000,
        minTurns: null,
        maxTurns: null,
      },
      statChanges: [],
      statChanceBasisPoints: 0,
      flinchChanceBasisPoints: 0,
      drainPercent: 0,
      healingPercent: 0,
    };

    const first = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(21),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.value.state;
    const afterFirst = state.combatants.find((entry) => entry.participantId === IDS.p2);
    expect(afterFirst?.majorStatus?.key).toBe("BAD_POISON");
    expect(afterFirst?.majorStatus?.counter).toBe(2);
    expect(afterFirst?.currentHp).toBe(150);

    const second = resolveTurn(
      state,
      [
        { type: "USE_MOVE", actorParticipantId: IDS.p1, moveSlot: 4, targetParticipantId: IDS.p2 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(22, BigInt(state.rngCounter)),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const afterSecond = second.value.state.combatants.find((entry) => entry.participantId === IDS.p2);
    expect(afterSecond?.majorStatus?.counter).toBe(3);
    expect(afterSecond?.currentHp).toBe(130);
  });

  it("Run Away is an allowlisted ability trigger on a legal FLEE action", () => {
    const state = battleState();
    const player = state.combatants.find((entry) => entry.participantId === IDS.p1);
    if (player === undefined) throw new Error("fixture incomplete");
    player.ability = { abilityId: IDS.runAway, effectKey: "run-away", effectConfig: {} };
    const result = resolveTurn(
      state,
      [
        { type: "FLEE", actorParticipantId: IDS.p1 },
        { type: "USE_MOVE", actorParticipantId: IDS.p2, moveSlot: 1, targetParticipantId: IDS.p1 },
      ],
      TEST_RULES,
      rng(13),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.status).toBe("FLED");
    expect(result.value.events.some((entry) => entry.type === "AbilityTriggered")).toBe(true);
  });

  it("heuristic AI always returns an action from the legal set", () => {
    const state = battleState();
    for (let seed = 1; seed <= 64; seed += 1) {
      const random = rng(seed);
      const action = chooseHeuristicAction(state, 2, TEST_RULES, random);
      expect(action).not.toBeNull();
      if (action !== null) expect(validateBattleAction(state, action, TEST_RULES)).toBeNull();
    }
  });

  it("survives a deterministic long-run without negative HP or impossible legal actions", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      let state = battleState(true);
      let counter = 0n;
      for (let step = 0; step < 100 && state.status === "ACTIVE"; step += 1) {
        const chooser = rng(seed, counter);
        const actions = state.sides
          .map((side) => chooseHeuristicAction(state, side.sideNo, TEST_RULES, chooser))
          .filter((action): action is NonNullable<typeof action> => action !== null);
        counter = chooser.counter;
        const resolverRng = rng(seed, counter);
        const result = resolveTurn(state, actions, TEST_RULES, resolverRng);
        expect(result.ok).toBe(true);
        if (!result.ok) break;
        state = result.value.state;
        counter = resolverRng.counter;
        for (const combatant of state.combatants) {
          expect(combatant.currentHp).toBeGreaterThanOrEqual(0);
          expect(combatant.currentHp).toBeLessThanOrEqual(combatant.maxHp);
        }
        if (state.status === "ACTIVE") {
          for (const side of state.sides) {
            const legal = legalActionsForSide(state, side.sideNo, TEST_RULES);
            const active = state.combatants.find(
              (entry) => entry.participantId === side.activeParticipantId,
            );
            if (active !== undefined && active.currentHp > 0)
              expect(legal.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
