import { BattleStateSchema, type BattleState } from "./contracts.js";
import type { BattleAdminCorrectionPatch } from "./admin-contracts.js";

export type BattleAdminCorrectionResult =
  | { readonly ok: true; readonly state: BattleState; readonly changes: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

export function correctActiveBattleState(
  source: BattleState,
  correction: BattleAdminCorrectionPatch,
): BattleAdminCorrectionResult {
  if (source.status !== "ACTIVE") {
    return { ok: false, reason: "Only ACTIVE Battle state may receive mechanical correction" };
  }
  const index = source.combatants.findIndex(
    (combatant) => combatant.participantId === correction.participantId,
  );
  if (index < 0) return { ok: false, reason: "Battle participant was not found" };

  const next = structuredClone(source);
  const combatant = next.combatants[index];
  if (combatant === undefined) return { ok: false, reason: "Battle participant was not found" };
  const changes: Record<string, unknown> = { participantId: combatant.participantId };

  if (correction.currentHp !== undefined) {
    if (correction.currentHp < 1 || correction.currentHp > combatant.maxHp) {
      return {
        ok: false,
        reason: "Admin HP correction must remain in 1..maxHp and cannot manufacture a faint",
      };
    }
    changes.currentHp = { before: combatant.currentHp, after: correction.currentHp };
    combatant.currentHp = correction.currentHp;
  }

  if (correction.majorStatus !== undefined) {
    changes.majorStatus = { before: combatant.majorStatus, after: correction.majorStatus };
    combatant.majorStatus = correction.majorStatus;
  }

  if (correction.movePp !== undefined) {
    const move = combatant.moves.find((entry) => entry.slotNo === correction.movePp?.slotNo);
    if (move === undefined) return { ok: false, reason: "Battle move slot was not found" };
    if (move.maxPp === null || move.ppCurrent === null) {
      return { ok: false, reason: "Battle move does not expose mutable PP" };
    }
    if (correction.movePp.ppCurrent > move.maxPp) {
      return { ok: false, reason: "Battle PP correction cannot exceed the move max PP" };
    }
    changes.movePp = {
      slotNo: move.slotNo,
      before: move.ppCurrent,
      after: correction.movePp.ppCurrent,
    };
    move.ppCurrent = correction.movePp.ppCurrent;
  }

  if (Object.keys(changes).length === 1) {
    return { ok: false, reason: "Battle correction did not change an allowlisted field" };
  }

  next.version += 1;
  const parsed = BattleStateSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, reason: "Corrected Battle state violates BattleState invariants" };
  }
  return { ok: true, state: parsed.data, changes };
}
