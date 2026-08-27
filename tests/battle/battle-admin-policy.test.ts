import { describe, expect, it } from "vitest";
import { correctActiveBattleState } from "../../src/modules/battle/admin-policy.js";
import { battleState } from "./fixtures.js";

describe("Battle admin correction policy", () => {
  it("creates one new version while preserving structural Battle authority", () => {
    const source = battleState();
    const participant = source.combatants[0];
    if (participant === undefined) throw new Error("Battle fixture has no combatant");
    const move = participant.moves.find((entry) => entry.maxPp !== null && entry.ppCurrent !== null);
    if (move === undefined || move.maxPp === null) throw new Error("Battle fixture has no PP move");
    const correctedPp = Math.max(0, move.maxPp - 1);
    const result = correctActiveBattleState(source, {
      participantId: participant.participantId,
      currentHp: Math.max(1, participant.currentHp - 1),
      majorStatus: { key: "PARALYSIS", counter: null },
      movePp: { slotNo: move.slotNo, ppCurrent: correctedPp },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(source.version + 1);
    expect(result.state.status).toBe(source.status);
    expect(result.state.turnNumber).toBe(source.turnNumber);
    expect(result.state.rngCounter).toBe(source.rngCounter);
    expect(result.state.sides).toEqual(source.sides);
    const after = result.state.combatants.find(
      (entry) => entry.participantId === participant.participantId,
    );
    expect(after?.majorStatus?.key).toBe("PARALYSIS");
    expect(after?.moves.find((entry) => entry.slotNo === move.slotNo)?.ppCurrent).toBe(correctedPp);
  });

  it("does not allow administrative HP correction to manufacture a faint", () => {
    const source = battleState();
    const participant = source.combatants[0];
    if (participant === undefined) throw new Error("Battle fixture has no combatant");
    const result = correctActiveBattleState(source, {
      participantId: participant.participantId,
      currentHp: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("cannot manufacture a faint");
  });

  it("rejects correction outside ACTIVE Battle and PP above pinned max", () => {
    const terminal = battleState();
    terminal.status = "CANCELLED";
    for (const side of terminal.sides) side.result = "CANCELLED";
    const participant = terminal.combatants[0];
    if (participant === undefined) throw new Error("Battle fixture has no combatant");
    const terminalResult = correctActiveBattleState(terminal, {
      participantId: participant.participantId,
      currentHp: 1,
    });
    expect(terminalResult.ok).toBe(false);

    const active = battleState();
    const activeParticipant = active.combatants[0];
    if (activeParticipant === undefined) throw new Error("Battle fixture has no combatant");
    const move = activeParticipant.moves.find(
      (entry) => entry.maxPp !== null && entry.ppCurrent !== null,
    );
    if (move === undefined || move.maxPp === null) throw new Error("Battle fixture has no PP move");
    const ppResult = correctActiveBattleState(active, {
      participantId: activeParticipant.participantId,
      movePp: { slotNo: move.slotNo, ppCurrent: move.maxPp + 1 },
    });
    expect(ppResult.ok).toBe(false);
  });
});
