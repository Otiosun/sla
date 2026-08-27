import type { BattleStatus } from "../battle/contracts.js";
import type { EncounterAdminState } from "./admin-contracts.js";

const ACTIVE_BATTLE_STATUSES: ReadonlySet<BattleStatus> = new Set([
  "CREATED",
  "ACTIVE",
  "RESOLVING_TURN",
]);

export function encounterAdminCloseUnsafeReason(state: EncounterAdminState): string | null {
  if (state.status === "CLOSED") return "Encounter is already CLOSED";
  if (state.status === "CAPTURE_RESOLVING" || state.pendingCaptureAttemptId !== null) {
    return "Encounter cannot be administratively closed while capture resolution is in flight";
  }
  if (state.status === "IN_BATTLE" && state.battle === null) {
    return "Encounter IN_BATTLE has no linked Battle; repair the inconsistent flow before closing";
  }
  if (state.battle !== null && ACTIVE_BATTLE_STATUSES.has(state.battle.status)) {
    return "Encounter cannot be administratively closed while its linked Battle is active";
  }
  if (
    state.battle !== null &&
    state.battle.status === "WON" &&
    (state.battle.battleType === "WILD" || state.battle.battleType === "NPC") &&
    !state.battle.rewardClaimed
  ) {
    return "Encounter cannot be administratively closed before terminal PvE Battle reward settlement";
  }
  return null;
}
