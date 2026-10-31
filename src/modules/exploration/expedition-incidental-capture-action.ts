import { appError, err, type Result } from "../../shared-kernel/result.js";
import type { PlayerId, EncounterId, CorrelationId } from "../../shared-kernel/ids.js";
import type { CaptureAttemptInput, CaptureAttemptResult } from "../capture/contracts.js";
import {
  selectCurrentIncidentalAction,
  type IncidentalEncounterPanel,
  type IncidentalBallKind,
} from "./expedition-v4-incidental-panel.js";

/**
 * Server-owned snapshot from the exact menu sent to this player. Never hydrate
 * these fields from untrusted WhatsApp text or caller-controlled item IDs.
 */
export interface IncidentalCaptureMenuSnapshot {
  readonly menu: IncidentalEncounterPanel;
  readonly outcomeId: string;
  readonly ballItemIds: Readonly<Partial<Record<IncidentalBallKind, string>>>;
}

export interface IncidentalCaptureActionInput {
  readonly playerId: PlayerId;
  readonly rawChoice: string;
  readonly expectedEncounterId: EncounterId;
  readonly expectedEncounterRevision: bigint;
  readonly snapshot: IncidentalCaptureMenuSnapshot;
  /** Stable inbound-message idempotency key, not a generated retry key. */
  readonly idempotencyKey: string;
  readonly correlationId: CorrelationId;
  readonly causationId: string | null;
}

export interface IncidentalOutcomeAuthorization {
  belongsToPlayer(input: {
    readonly playerId: PlayerId;
    readonly encounterId: EncounterId;
    readonly outcomeId: string;
  }): Promise<boolean>;
}

export interface IncidentalCaptureMutation {
  attempt(input: CaptureAttemptInput): Promise<Result<CaptureAttemptResult>>;
}

/**
 * One-tap Ball choice bridge for the future /explorar WhatsApp dispatcher.
 *
 * All CaptureService invariants remain there: inventory CAS/debit, capture
 * probability, entitlement, attempt receipt, Pokemon TEAM/BOX and replay.
 * The incoming choice is only a number. No extra confirmation screen.
 *
 * This is NOT registered as a live command. A trusted route must load the
 * immutable server-issued menu snapshot before invoking this action.
 */
export class ExpeditionIncidentalCaptureAction {
  public constructor(
    private readonly authorize: IncidentalOutcomeAuthorization,
    private readonly capture: IncidentalCaptureMutation,
  ) {}

  public async execute(input: IncidentalCaptureActionInput): Promise<Result<CaptureAttemptResult>> {
    const selection = selectCurrentIncidentalAction({
      raw: input.rawChoice,
      menu: input.snapshot.menu,
      expectedEncounterId: input.expectedEncounterId,
      expectedEncounterRevision: input.expectedEncounterRevision,
    });
    if (!selection.ok) return selection;
    if (selection.value.kind !== "CAPTURE") {
      return err(appError("ACTION_INVALID", "The selected incidental action is not a Ball"));
    }
    if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 200) {
      return err(appError("VALIDATION_FAILED", "Missing stable capture idempotency key"));
    }
    const ballId = input.snapshot.ballItemIds[selection.value.ball];
    if (ballId === undefined || !/^[a-f0-9-]{36}$/iu.test(ballId)) {
      return err(appError("FLOW_BLOCKED", "The selected Ball has no authorized item mapping"));
    }
    const authorized = await this.authorize.belongsToPlayer({
      playerId: input.playerId,
      encounterId: input.expectedEncounterId,
      outcomeId: input.snapshot.outcomeId,
    });
    if (!authorized) {
      return err(
        appError("FLOW_BLOCKED", "Incidental encounter no longer belongs to this trainer"),
      );
    }
    // CaptureService performs the authoritative last-moment encounter revision,
    // inventory, policy, battle and replay checks inside its own transaction.
    // The menu is NOT an inventory grant or capture authorization by itself.
    return this.capture.attempt({
      playerId: input.playerId,
      encounterId: input.expectedEncounterId,
      expectedEncounterRevision: input.expectedEncounterRevision,
      expectedBattleVersion: null,
      targetWildNo: 1,
      ballItemId: ballId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }
}
