import { describe, expect, it } from "vitest";
import { chooseHeuristicAction } from "../../src/modules/battle/ai.js";
import { legalActionsForSide, validateBattleAction } from "../../src/modules/battle/legal.js";
import { resolveTurn } from "../../src/modules/battle/resolver.js";
import { CounterRandomSource } from "../../src/platform/rng/counter-rng.js";
import { IDS, TEST_RULES, battleState } from "./fixtures.js";

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
