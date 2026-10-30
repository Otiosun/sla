import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { EXPEDITION_DURATION_MINUTES, type ExpeditionPeriod } from "./expedition-clock.js";
import { expeditionWeeklyAdmission } from "./expedition-week.js";

export type ExpeditionPhase = "PREPARING" | "ACTIVE" | "ENDED";
export type ExpeditionEndReason = "CANCELLED" | "VOLUNTARY" | "CLOCK" | "BLACKOUT";

/**
 * Persisted snapshot, not an in-memory timer. A repository must serialize
 * revisions and keep idempotency receipts in the same DB transaction as
 * weekly reservations and world effects before using these transitions.
 */
export interface ExpeditionSnapshot {
  readonly expeditionId: string;
  readonly playerId: string;
  readonly period: ExpeditionPeriod;
  readonly areaId: string;
  readonly phase: ExpeditionPhase;
  readonly elapsedMinutes: number;
  readonly consumedWeekKey: string | null;
  readonly endReason: ExpeditionEndReason | null;
  readonly revision: bigint;
}

export interface ExpeditionTransition {
  readonly expedition: ExpeditionSnapshot;
  readonly consumedWeeklySlot: boolean;
  readonly changed: boolean;
}

function invalid(message: string): Result<never> {
  return err(appError("INVALID_STATE_TRANSITION", message));
}

function guard(expedition: ExpeditionSnapshot, expectedRevision: bigint): Result<void> {
  if (expectedRevision < 0n || expedition.revision !== expectedRevision) {
    return err(
      appError("REVISION_CONFLICT", "Expedition revision has changed", {
        userMessage: "Sua expedição foi atualizada. Consulte a RotomDex e tente novamente.",
      }),
    );
  }
  if (
    !Number.isSafeInteger(expedition.elapsedMinutes) ||
    expedition.elapsedMinutes < 0 ||
    expedition.elapsedMinutes > EXPEDITION_DURATION_MINUTES
  ) {
    return invalid("Expedition clock is outside its legal bounds");
  }
  if (expedition.phase === "PREPARING") {
    return expedition.elapsedMinutes === 0 &&
      expedition.consumedWeekKey === null &&
      expedition.endReason === null
      ? ok(undefined)
      : invalid("Preparing expedition has already consumed time or quota");
  }
  if (expedition.phase === "ACTIVE") {
    return expedition.elapsedMinutes > 0 &&
      expedition.elapsedMinutes < EXPEDITION_DURATION_MINUTES &&
      expedition.consumedWeekKey !== null &&
      expedition.endReason === null
      ? ok(undefined)
      : invalid("Active expedition has inconsistent time, quota or termination");
  }
  if (expedition.phase === "ENDED") {
    const cancelled =
      expedition.endReason === "CANCELLED" &&
      expedition.elapsedMinutes === 0 &&
      expedition.consumedWeekKey === null;
    const finished =
      expedition.endReason !== null &&
      expedition.endReason !== "CANCELLED" &&
      expedition.consumedWeekKey !== null &&
      expedition.elapsedMinutes > 0 &&
      (expedition.endReason !== "CLOCK" ||
        expedition.elapsedMinutes === EXPEDITION_DURATION_MINUTES);
    return cancelled || finished ? ok(undefined) : invalid("Ended expedition has invalid state");
  }
  return invalid("Unknown expedition phase");
}

function mondayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCDay() === 1
  );
}

export function advanceExpedition(input: {
  readonly expedition: ExpeditionSnapshot;
  readonly expectedRevision: bigint;
  readonly minutes: number;
  readonly weekKey: string;
  readonly consumedThisWeek: number;
}): Result<ExpeditionTransition> {
  const current = input.expedition;
  const safe = guard(current, input.expectedRevision);
  if (!safe.ok) return safe;
  if (current.phase === "ENDED") {
    return err(appError("FLOW_BLOCKED", "Expedition has already ended"));
  }
  if (
    !Number.isSafeInteger(input.minutes) ||
    input.minutes < 0 ||
    input.minutes > EXPEDITION_DURATION_MINUTES
  ) {
    return err(appError("VALIDATION_FAILED", "Invalid expedition action duration"));
  }
  if (input.minutes === 0) {
    return ok({ expedition: current, consumedWeeklySlot: false, changed: false });
  }
  if (input.minutes > EXPEDITION_DURATION_MINUTES - current.elapsedMinutes) {
    return err(
      appError("FLOW_BLOCKED", "Not enough expedition time for this action", {
        remainingMinutes: EXPEDITION_DURATION_MINUTES - current.elapsedMinutes,
        userMessage: "Não há tempo suficiente nesta expedição para realizar essa ação.",
      }),
    );
  }

  const firstAction = current.phase === "PREPARING";
  if (firstAction) {
    if (!mondayKey(input.weekKey)) {
      return err(appError("VALIDATION_FAILED", "Expedition week key must be a valid Monday"));
    }
    const admission = expeditionWeeklyAdmission(input.consumedThisWeek, "PREPARING");
    if (!admission.canConsumeFirstAction) {
      return err(
        appError("FLOW_BLOCKED", "Expedition weekly limit reached", {
          userMessage: "Você já utilizou suas três expedições desta semana.",
        }),
      );
    }
  }
  const elapsedMinutes = current.elapsedMinutes + input.minutes;
  const isLastAction = elapsedMinutes === EXPEDITION_DURATION_MINUTES;
  return ok({
    expedition: {
      ...current,
      phase: isLastAction ? "ENDED" : "ACTIVE",
      elapsedMinutes,
      consumedWeekKey: firstAction ? input.weekKey : current.consumedWeekKey,
      endReason: isLastAction ? "CLOCK" : null,
      revision: current.revision + 1n,
    },
    consumedWeeklySlot: firstAction,
    changed: true,
  });
}

/**
 * Changing the day/night choice is free ONLY while still PREPARING.
 * This pure transition does not reserve quota and never rewinds ACTIVE time.
 * Callers must serialize revision/receipt with the persisted snapshot.
 */
export function changeExpeditionPeriod(input: {
  readonly expedition: ExpeditionSnapshot;
  readonly expectedRevision: bigint;
  readonly period: ExpeditionPeriod;
}): Result<ExpeditionTransition> {
  const current = input.expedition;
  const safe = guard(current, input.expectedRevision);
  if (!safe.ok) return safe;
  if (current.phase !== "PREPARING") {
    return err(appError("FLOW_BLOCKED", "The expedition period cannot change after the first action"));
  }
  if (input.period !== "DAY" && input.period !== "NIGHT") {
    return err(appError("VALIDATION_FAILED", "Invalid expedition period"));
  }
  if (current.period === input.period) {
    return ok({ expedition: current, consumedWeeklySlot: false, changed: false });
  }
  return ok({
    expedition: { ...current, period: input.period, revision: current.revision + 1n },
    consumedWeeklySlot: false,
    changed: true,
  });
}

export function endExpedition(input: {
  readonly expedition: ExpeditionSnapshot;
  readonly expectedRevision: bigint;
  readonly reason: "CANCELLED" | "VOLUNTARY" | "BLACKOUT";
}): Result<ExpeditionTransition> {
  const current = input.expedition;
  const safe = guard(current, input.expectedRevision);
  if (!safe.ok) return safe;
  if (current.phase === "ENDED") {
    return err(appError("FLOW_BLOCKED", "Expedition has already ended"));
  }
  if (
    (current.phase === "PREPARING" && input.reason !== "CANCELLED") ||
    (current.phase === "ACTIVE" && input.reason === "CANCELLED")
  ) {
    return invalid("Only a preparing expedition can be cancelled without consuming a slot");
  }
  return ok({
    expedition: {
      ...current,
      phase: "ENDED",
      endReason: input.reason,
      revision: current.revision + 1n,
    },
    consumedWeeklySlot: false,
    changed: true,
  });
}

export function expeditionRequiresReport(expedition: ExpeditionSnapshot): boolean {
  return (
    expedition.phase === "ENDED" &&
    (expedition.endReason === "VOLUNTARY" || expedition.endReason === "CLOCK")
  );
}
