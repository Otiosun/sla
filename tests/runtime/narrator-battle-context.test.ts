import { describe, expect, it, vi } from "vitest";
import type { BattleState } from "../../src/modules/battle/contracts.js";
import { filterActiveNarratorBattleIds } from "../../src/runtime/narrator-battle-context.js";

function state(
  battleId: string,
  activeParticipantId: string,
  status: BattleState["status"] = "ACTIVE",
): BattleState {
  return {
    battleId,
    status,
    sides: [
      {
        sideNo: 2,
        participantIds: [activeParticipantId],
        activeParticipantId,
        result: null,
      },
    ],
  } as unknown as BattleState;
}

describe("narrator battle context", () => {
  it("keeps only battles where the narrator-controlled participant is active now", async () => {
    const activeBattleId = "11111111-1111-4111-8111-111111111111";
    const staleBattleId = "22222222-2222-4222-8222-222222222222";
    const endedBattleId = "33333333-3333-4333-8333-333333333333";
    const narratorActive = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const narratorStale = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newActiveWild = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const narratorEnded = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const states = new Map<string, BattleState>([
      [activeBattleId, state(activeBattleId, narratorActive)],
      [staleBattleId, state(staleBattleId, newActiveWild)],
      [endedBattleId, state(endedBattleId, narratorEnded, "COMPLETED")],
    ]);
    const loadState = vi.fn(async (battleId: string) => states.get(battleId) ?? null);

    await expect(
      filterActiveNarratorBattleIds(
        [
          { battleId: staleBattleId, participantId: narratorStale },
          { battleId: activeBattleId, participantId: narratorActive },
          { battleId: endedBattleId, participantId: narratorEnded },
        ],
        loadState,
      ),
    ).resolves.toEqual([activeBattleId]);
  });

  it("deduplicates a battle when multiple narrator controllers point to active slots", async () => {
    const battleId = "44444444-4444-4444-8444-444444444444";
    const first = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const second = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const multiSlot = {
      ...state(battleId, first),
      sides: [
        {
          sideNo: 2,
          participantIds: [first, second],
          activeParticipantId: first,
          slots: [
            { participantIds: [first], activeParticipantId: first },
            { participantIds: [second], activeParticipantId: second },
          ],
          result: null,
        },
      ],
    } as unknown as BattleState;

    await expect(
      filterActiveNarratorBattleIds(
        [
          { battleId, participantId: first },
          { battleId, participantId: second },
        ],
        async () => multiSlot,
      ),
    ).resolves.toEqual([battleId]);
  });
});
