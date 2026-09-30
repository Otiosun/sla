import type { BattleState } from "../modules/battle/contracts.js";

export interface NarratorBattleCandidate {
  readonly battleId: string;
  readonly participantId: string;
}

export async function filterActiveNarratorBattleIds(
  candidates: readonly NarratorBattleCandidate[],
  loadState: (battleId: string) => Promise<BattleState | null>,
): Promise<readonly string[]> {
  const byBattle = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const participants = byBattle.get(candidate.battleId) ?? new Set<string>();
    participants.add(candidate.participantId);
    byBattle.set(candidate.battleId, participants);
  }

  const activeBattleIds: string[] = [];
  for (const battleId of [...byBattle.keys()].sort()) {
    const state = await loadState(battleId);
    if (state === null || state.status !== "ACTIVE") continue;
    const activeParticipantIds = new Set(
      state.sides.flatMap((side) => (side.slots ?? [side]).map((slot) => slot.activeParticipantId)),
    );
    const narratorParticipants = byBattle.get(battleId);
    if (
      narratorParticipants !== undefined &&
      [...narratorParticipants].some((participantId) => activeParticipantIds.has(participantId))
    ) {
      activeBattleIds.push(battleId);
    }
  }
  return activeBattleIds;
}
