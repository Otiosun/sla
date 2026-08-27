import { createHash } from "node:crypto";
import type {
  BattleAdminCorrectStateInput,
  BattleAdminForceCancelInput,
  BattleAdminInspection,
  BattleAdminMutationResult,
} from "./admin-contracts.js";
import type { BattleAdminRepository } from "./admin-ports.js";
import type { BattleCancellationPort } from "./runtime.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

function hashRequest(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cancellationHash(input: BattleAdminForceCancelInput): string {
  return hashRequest({
    kind: "FORCE_CANCEL",
    playerId: input.playerId,
    battleId: input.battleId,
    expectedVersion: input.expectedVersion,
    correlationId: input.correlationId,
    metadata: input.metadata,
  });
}

function correctionHash(input: BattleAdminCorrectStateInput): string {
  return hashRequest({
    kind: "CORRECT_STATE",
    playerId: input.playerId,
    battleId: input.battleId,
    expectedVersion: input.expectedVersion,
    correlationId: input.correlationId,
    metadata: input.metadata,
    correction: input.correction,
  });
}

export class BattleAdminOwnerService {
  public constructor(
    private readonly repository: BattleAdminRepository,
    private readonly cancellation: BattleCancellationPort,
  ) {}

  public async inspect(playerId: string, battleId: string): Promise<Result<BattleAdminInspection>> {
    const state = await this.repository.inspect(playerId, battleId);
    return state === null
      ? err(appError("NOT_FOUND", "Battle administrative target was not found"))
      : ok(state);
  }

  public async forceCancel(
    input: BattleAdminForceCancelInput,
  ): Promise<Result<BattleAdminMutationResult>> {
    const requestFingerprint = cancellationHash(input);
    const prior = await this.repository.replayMutation(
      input.battleId,
      input.idempotencyKey,
      "FORCE_CANCEL",
      requestFingerprint,
    );
    if (prior.kind === "CONFLICT") {
      return err(
        appError("FINGERPRINT_MISMATCH", "Battle admin request conflicts with stored evidence"),
      );
    }
    if (prior.kind === "REPLAYED") return ok(prior.result);

    const before = await this.repository.inspect(input.playerId, input.battleId);
    if (before === null)
      return err(appError("NOT_FOUND", "Battle administrative target was not found"));
    if (before.battleType === "PVP") {
      return err(
        appError("ACTION_INVALID", "Subject-scoped Battle cancellation is not allowed for PVP"),
      );
    }
    if (before.version !== input.expectedVersion) {
      return err(
        appError("REVISION_CONFLICT", "Battle version changed", {
          actualRevision: String(before.version),
        }),
      );
    }
    if (before.status !== "ACTIVE" || before.state?.status !== "ACTIVE") {
      return err(appError("INVALID_STATE_TRANSITION", "Only an ACTIVE Battle can be cancelled"));
    }

    const persisted = await this.cancellation.cancel({
      battleId: input.battleId,
      expectedVersion: input.expectedVersion,
      reason: input.metadata.reason,
      causationId: input.idempotencyKey,
      correlationId: input.correlationId,
      requestFingerprint,
    });

    if (persisted.kind === "IDEMPOTENCY_CONFLICT") {
      return err(
        appError("FINGERPRINT_MISMATCH", "Battle cancellation evidence conflicts with request"),
      );
    }
    if (persisted.kind === "NOT_FOUND") return err(appError("NOT_FOUND", "Battle was not found"));
    if (persisted.kind === "NOT_INITIALIZED")
      return err(appError("ACTION_INVALID", "Battle has no initialized snapshot"));
    if (persisted.kind === "NOT_ACTIVE")
      return err(appError("INVALID_STATE_TRANSITION", "Battle is no longer ACTIVE"));
    if (persisted.kind === "VERSION_CONFLICT") {
      return err(
        appError("REVISION_CONFLICT", "Battle version changed", {
          actualRevision: String(persisted.currentState.version),
        }),
      );
    }
    if (persisted.kind === "REPLAYED") {
      const replay = await this.repository.replayMutation(
        input.battleId,
        input.idempotencyKey,
        "FORCE_CANCEL",
        requestFingerprint,
      );
      if (replay.kind === "REPLAYED") return ok(replay.result);
      if (replay.kind === "CONFLICT")
        return err(
          appError("FINGERPRINT_MISMATCH", "Battle cancellation evidence conflicts with request"),
        );
      return err(
        appError("ACTION_INVALID", "Cancelled Battle is missing administrative replay evidence"),
      );
    }

    const after = await this.repository.inspect(input.playerId, input.battleId);
    if (after === null) throw new Error("Battle disappeared after cancellation persistence");
    return ok({
      operationKind: "FORCE_CANCEL",
      beforeVersion: before.version,
      afterVersion: after.version,
      beforeState: before,
      afterState: after,
      replayed: false,
      encounterNeedsClose:
        after.encounterId !== null &&
        after.encounterStatus === "IN_BATTLE" &&
        after.status === "CANCELLED",
    });
  }

  public async correctState(
    input: BattleAdminCorrectStateInput,
  ): Promise<Result<BattleAdminMutationResult>> {
    const requestFingerprint = correctionHash(input);
    const persisted = await this.repository.correctState({ ...input, requestFingerprint });
    if (persisted.kind === "PERSISTED" || persisted.kind === "REPLAYED")
      return ok(persisted.result);
    if (persisted.kind === "IDEMPOTENCY_CONFLICT")
      return err(
        appError("FINGERPRINT_MISMATCH", "Battle admin request conflicts with stored evidence"),
      );
    if (persisted.kind === "NOT_FOUND")
      return err(appError("NOT_FOUND", "Battle administrative target was not found"));
    if (persisted.kind === "NOT_ACTIVE")
      return err(appError("INVALID_STATE_TRANSITION", "Only an ACTIVE Battle can be corrected"));
    if (persisted.kind === "VERSION_CONFLICT") {
      return err(
        appError("REVISION_CONFLICT", "Battle version changed", {
          actualRevision: String(persisted.current.version),
        }),
      );
    }
    return err(appError("ACTION_INVALID", persisted.reason));
  }
}
