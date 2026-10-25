import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  expeditionRequiresReport,
  type ExpeditionSnapshot,
} from "./expedition-state.js";

/** A proposal, never a wallet, item, XP or progression mutation. */
export type ReportBonusKind = "MONEY" | "POKE_BALL" | "POTION" | "TRAINER_PROGRESS";

export interface ExpeditionReportBonus {
  readonly kind: ReportBonusKind;
  readonly quantity: number;
}

export interface ExpeditionSettlementProposal {
  readonly expeditionId: string;
  readonly playerId: string;
  readonly approvalKind: "NORMAL" | "HIGHLIGHT";
  readonly baseMoney: 300;
  readonly normalBonus: ExpeditionReportBonus;
  readonly highlightBonus: ExpeditionReportBonus | null;
  readonly totalMoney: number;
  readonly pokeBalls: number;
  readonly potions: number;
  readonly trainerProgress: number;
}

/** A fixed, approved amount for a normally completed expedition report. */
export const EXPEDITION_REPORT_BASE_MONEY = 300;

function bonusForNormalRoll(roll: number): ExpeditionReportBonus {
  if (roll < 45) return { kind: "MONEY", quantity: 200 };
  if (roll < 75) return { kind: "POKE_BALL", quantity: 1 };
  if (roll < 90) return { kind: "POTION", quantity: 1 };
  return { kind: "TRAINER_PROGRESS", quantity: 50 };
}

function bonusForHighlightRoll(roll: number): ExpeditionReportBonus {
  if (roll < 60) return { kind: "MONEY", quantity: 100 };
  if (roll < 85) return { kind: "POKE_BALL", quantity: 1 };
  if (roll < 95) return { kind: "POTION", quantity: 1 };
  return { kind: "TRAINER_PROGRESS", quantity: 25 };
}

function trustedRoll(nextInt: (upperExclusive: number) => number): Result<number> {
  const roll = nextInt(100);
  return Number.isSafeInteger(roll) && roll >= 0 && roll < 100
    ? ok(roll)
    : err(appError("ACTION_INVALID", "Trusted report reward RNG generated an invalid draw"));
}

/**
 * Pure V1.6 settlement proposal. The admin chooses whether the external
 * >=100-word report is approved as NORMAL/HIGHLIGHT or rejected; the admin
 * cannot choose bonus outcomes. The RNG, ledger and catalog are authoritative
 * server-side dependencies, never WhatsApp-provided inputs.
 *
 * Calling this does NOT write a report review, add currency/items/progression
 * or issue an idempotency receipt. That atomic integration remains blocked.
 */
export function proposeExpeditionReportSettlement(input: {
  readonly expedition: Pick<
    ExpeditionSnapshot,
    "expeditionId" | "playerId" | "phase" | "endReason" | "consumedWeekKey"
  >;
  readonly approvalKind: "NORMAL" | "HIGHLIGHT" | "REJECTED";
  readonly nextInt: (upperExclusive: number) => number;
}): Result<ExpeditionSettlementProposal | null> {
  if (!expeditionRequiresReport(input.expedition as ExpeditionSnapshot)) {
    return err(
      appError("FLOW_BLOCKED", "Expedition did not end with a report-eligible outcome", {
        userMessage: "Esta expedição não dá direito à recompensa de conclusão.",
      }),
    );
  }
  if (input.expedition.consumedWeekKey === null) {
    return err(appError("INVALID_STATE_TRANSITION", "Completed expedition has no weekly debit"));
  }
  if (input.approvalKind === "REJECTED") return ok(null);

  const normalRoll = trustedRoll(input.nextInt);
  if (!normalRoll.ok) return normalRoll;
  const normalBonus = bonusForNormalRoll(normalRoll.value);

  let highlightBonus: ExpeditionReportBonus | null = null;
  if (input.approvalKind === "HIGHLIGHT") {
    const highlightRoll = trustedRoll(input.nextInt);
    if (!highlightRoll.ok) return highlightRoll;
    highlightBonus = bonusForHighlightRoll(highlightRoll.value);
  }

  const allBonuses = [
    normalBonus,
    ...(highlightBonus === null ? [] : [highlightBonus]),
  ];
  const sumByKind = (kind: ReportBonusKind): number =>
    allBonuses
      .filter((bonus) => bonus.kind === kind)
      .reduce((total, bonus) => total + bonus.quantity, 0);

  return ok({
    expeditionId: input.expedition.expeditionId,
    playerId: input.expedition.playerId,
    approvalKind: input.approvalKind,
    baseMoney: EXPEDITION_REPORT_BASE_MONEY,
    normalBonus,
    highlightBonus,
    totalMoney: EXPEDITION_REPORT_BASE_MONEY + sumByKind("MONEY"),
    pokeBalls: sumByKind("POKE_BALL"),
    potions: sumByKind("POTION"),
    trainerProgress: sumByKind("TRAINER_PROGRESS"),
  });
}
