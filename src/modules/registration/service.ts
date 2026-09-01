import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { RegistrationDraftInput, RegistrationSnapshot } from "./contracts.js";
import type { RegistrationDraftRecord, RegistrationRepository, RegistrationRevisionRecord } from "./ports.js";
import { validateRegistrationDraft } from "./validation.js";

export interface SaveRegistrationDraftInput {
  readonly playerId: PlayerId;
  readonly draft: RegistrationDraftInput;
  readonly expectedRevision: number | null;
}

export interface SubmitRegistrationInput {
  readonly playerId: PlayerId;
  readonly idempotencyKey: string;
}

export interface SubmitRegistrationResult extends RegistrationRevisionRecord {
  readonly replayed: boolean;
}

export interface WithdrawRegistrationInput {
  readonly playerId: PlayerId;
  readonly revisionId: string;
  readonly expectedRevision: number;
}

function snapshotCopy(snapshot: RegistrationSnapshot): RegistrationSnapshot {
  return { ...snapshot };
}

export class RegistrationService {
  public constructor(private readonly repository: RegistrationRepository) {}

  public async saveDraft(input: SaveRegistrationDraftInput): Promise<Result<RegistrationDraftRecord>> {
    const validation = validateRegistrationDraft(input.draft);
    if (!validation.ok) return validation;

    return this.repository.transaction(async (tx) => {
      const saved = await tx.saveDraft({
        playerId: input.playerId,
        snapshot: snapshotCopy(validation.value),
        expectedRevision: input.expectedRevision,
      });
      return saved === null
        ? err(appError("REVISION_CONFLICT", "Registration draft revision conflict"))
        : ok(saved);
    });
  }

  public async submit(input: SubmitRegistrationInput): Promise<Result<SubmitRegistrationResult>> {
    const key = input.idempotencyKey.trim();
    if (key.length === 0 || key.length > 512) {
      return err(appError("IDEMPOTENCY_KEY_INVALID", "Invalid registration idempotency key"));
    }

    return this.repository.transaction(async (tx) => {
      const replay = await tx.loadIdempotencyReceipt("SUBMIT", key);
      if (replay !== null) return ok({ ...replay, replayed: true });

      const draft = await tx.loadDraft(input.playerId);
      if (draft === null) return err(appError("NOT_FOUND", "Registration draft not found"));

      const validation = validateRegistrationDraft(draft.snapshot);
      if (!validation.ok) return validation;

      const current = await tx.loadCurrentRevision(input.playerId);
      if (current?.status === "SUBMITTED") {
        return err(appError("INVALID_STATE_TRANSITION", "Registration review is already submitted"));
      }

      const inserted = await tx.insertRevision({
        playerId: input.playerId,
        sequenceNo: (current?.sequenceNo ?? 0) + 1,
        snapshot: snapshotCopy(validation.value),
      });
      await tx.saveIdempotencyReceipt("SUBMIT", key, inserted.id);
      return ok({ ...inserted, replayed: false });
    });
  }

  public async withdraw(input: WithdrawRegistrationInput): Promise<Result<RegistrationRevisionRecord>> {
    return this.repository.transaction(async (tx) => {
      const current = await tx.loadCurrentRevision(input.playerId);
      if (current === null || current.id !== input.revisionId) {
        return err(appError("NOT_FOUND", "Current registration review not found"));
      }
      if (current.status !== "SUBMITTED") {
        return err(appError("INVALID_STATE_TRANSITION", "Only submitted registration can be withdrawn"));
      }
      const updated = await tx.updateRevisionStatus(current.id, input.expectedRevision, "WITHDRAWN");
      return updated === null
        ? err(appError("REVISION_CONFLICT", "Registration review revision conflict"))
        : ok(updated);
    });
  }
}
