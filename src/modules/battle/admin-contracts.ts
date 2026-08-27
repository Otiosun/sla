import type { BattleState, BattleStatus, BattleType } from "./contracts.js";

export interface BattleAdminMetadata {
  readonly sourceType: "ADMIN_OPERATION";
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: "ADMIN";
  readonly actorId: string;
}

export interface BattleAdminStateView extends Readonly<Record<string, unknown>> {
  readonly battleId: string;
  readonly playerId: string;
  readonly battleType: BattleType;
  readonly status: BattleStatus;
  readonly version: number;
  readonly turnNumber: number;
  readonly endedAt: string | null;
  readonly encounterId: string | null;
  readonly encounterStatus: string | null;
  readonly rewardClaimed: boolean;
  readonly state: BattleState | null;
}

export interface BattleAdminEventView {
  readonly seq: string;
  readonly battleVersion: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface BattleAdminActionView {
  readonly actionId: string;
  readonly actionType: string;
  readonly status: string;
  readonly expectedVersion: number;
  readonly resolvedVersion: number | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface BattleAdminInspection extends BattleAdminStateView {
  readonly recentEvents: readonly BattleAdminEventView[];
  readonly recentActions: readonly BattleAdminActionView[];
}

export interface BattleAdminForceCancelInput {
  readonly playerId: string;
  readonly battleId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly metadata: BattleAdminMetadata;
}

export interface BattleAdminCorrectionPatch {
  readonly participantId: string;
  readonly currentHp?: number;
  readonly majorStatus?: BattleState["combatants"][number]["majorStatus"];
  readonly movePp?: Readonly<{ slotNo: number; ppCurrent: number }>;
}

export interface BattleAdminCorrectStateInput extends BattleAdminForceCancelInput {
  readonly correction: BattleAdminCorrectionPatch;
}

export interface BattleAdminMutationResult {
  readonly operationKind: "FORCE_CANCEL" | "CORRECT_STATE";
  readonly beforeVersion: number;
  readonly afterVersion: number;
  readonly beforeState: BattleAdminStateView;
  readonly afterState: BattleAdminStateView;
  readonly replayed: boolean;
  readonly encounterNeedsClose: boolean;
}
