import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  RegistrationDraftInput,
  RegistrationReviewActor,
  RegistrationSnapshot,
} from "./contracts.js";
import type {
  RegistrationDraftRecord,
  RegistrationIdempotentOperation,
  RegistrationRepository,
  RegistrationRevisionRecord,
  RegistrationRevisionStatus,
} from "./ports.js";
import { normalizeRegistrationDraft, validateRegistrationDraft } from "./validation.js";

export interface SaveRegistrationDraftInput {
  readonly playerId: PlayerId;
  readonly draft: RegistrationDraftInput;
  readonly expectedRevision: number | null;
}

export interface SaveAndSubmitRegistrationInput {
  readonly playerId: PlayerId;
  readonly draft: RegistrationDraftInput;
  readonly expectedDraftRevision: number | null;
  readonly idempotencyKey: string;
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

export interface ReviewRegistrationInput {
  readonly reviewId: string;
  readonly expectedRevision: number;
  readonly actor: RegistrationReviewActor;
  readonly idempotencyKey: string;
}

export interface ReviewRegistrationResult extends RegistrationRevisionRecord {
  readonly replayed: boolean;
}

function draftCopy(draft: RegistrationDraftInput): RegistrationDraftInput {
  return { ...draft };
}

function snapshotCopy(snapshot: RegistrationSnapshot): RegistrationSnapshot {
  return { ...snapshot };
}

function sameSnapshot(left: RegistrationSnapshot, right: RegistrationSnapshot): boolean {
  return (
    left.trainerName === right.trainerName &&
    left.age === right.age &&
    left.genderPronouns === right.genderPronouns &&
    left.appearance === right.appearance &&
    left.personality === right.personality &&
    left.backstory === right.backstory &&
    left.starterFormId === right.starterFormId &&
    left.regionId === right.regionId &&
    left.schemaVersion === right.schemaVersion
  );
}

function normalizeIdempotencyKey(value: string): Result<string> {
  const key = value.trim();
  if (key.length === 0 || key.length > 512) {
    return err(appError("IDEMPOTENCY_KEY_INVALID", "Invalid registration idempotency key"));
  }
  return ok(key);
}

export class RegistrationService {
  public constructor(private readonly repository: RegistrationRepository) {}

  public async getDraft(playerId: PlayerId): Promise<Result<RegistrationDraftRecord>> {
    return this.repository.read(async (tx) => {
      const draft = await tx.loadDraft(playerId);
      return draft === null
        ? err(appError("NOT_FOUND", "Registration draft not found"))
        : ok(draft);
    });
  }

  public async saveDraft(
    input: SaveRegistrationDraftInput,
  ): Promise<Result<RegistrationDraftRecord>> {
    const validation = normalizeRegistrationDraft(input.draft);
    if (!validation.ok) return validation;

    return this.repository.transaction(async (tx) => {
      const saved = await tx.saveDraft({
        playerId: input.playerId,
        snapshot: draftCopy(validation.value),
        expectedRevision: input.expectedRevision,
      });
      return saved === null
        ? err(appError("REVISION_CONFLICT", "Registration draft revision conflict"))
        : ok(saved);
    });
  }

  public async saveAndSubmit(
    input: SaveAndSubmitRegistrationInput,
  ): Promise<Result<SubmitRegistrationResult>> {
    const validation = validateRegistrationDraft(input.draft);
    if (!validation.ok) return validation;
    const keyResult = normalizeIdempotencyKey(input.idempotencyKey);
    if (!keyResult.ok) return keyResult;
    const key = keyResult.value;

    return this.repository.transaction(async (tx) => {
      const replay = await tx.loadIdempotencyReceipt("SUBMIT", key);
      if (replay !== null) {
        if (replay.playerId !== input.playerId || !sameSnapshot(replay.snapshot, validation.value)) {
          return err(
            appError(
              "FINGERPRINT_MISMATCH",
              "Registration idempotency key belongs to another confirmation",
            ),
          );
        }
        return ok({ ...replay, replayed: true });
      }

      const current = await tx.loadCurrentRevision(input.playerId);
      if (current?.status === "SUBMITTED") {
        return err(
          appError("INVALID_STATE_TRANSITION", "Registration review is already submitted"),
        );
      }

      const saved = await tx.saveDraft({
        playerId: input.playerId,
        snapshot: draftCopy(validation.value),
        expectedRevision: input.expectedDraftRevision,
      });
      if (saved === null) {
        return err(appError("REVISION_CONFLICT", "Registration draft revision conflict"));
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

  public async submit(input: SubmitRegistrationInput): Promise<Result<SubmitRegistrationResult>> {
    const keyResult = normalizeIdempotencyKey(input.idempotencyKey);
    if (!keyResult.ok) return keyResult;
    const key = keyResult.value;

    return this.repository.transaction(async (tx) => {
      const replay = await tx.loadIdempotencyReceipt("SUBMIT", key);
      if (replay !== null) return ok({ ...replay, replayed: true });

      const draft = await tx.loadDraft(input.playerId);
      if (draft === null) return err(appError("NOT_FOUND", "Registration draft not found"));

      const validation = validateRegistrationDraft(draft.snapshot);
      if (!validation.ok) return validation;

      const current = await tx.loadCurrentRevision(input.playerId);
      if (current?.status === "SUBMITTED") {
        return err(
          appError("INVALID_STATE_TRANSITION", "Registration review is already submitted"),
        );
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

  public async withdraw(
    input: WithdrawRegistrationInput,
  ): Promise<Result<RegistrationRevisionRecord>> {
    return this.repository.transaction(async (tx) => {
      const current = await tx.loadCurrentRevision(input.playerId);
      if (current === null || current.id !== input.revisionId) {
        return err(appError("NOT_FOUND", "Current registration review not found"));
      }
      if (current.status !== "SUBMITTED") {
        return err(
          appError("INVALID_STATE_TRANSITION", "Only submitted registration can be withdrawn"),
        );
      }
      const updated = await tx.updateRevisionStatus(
        current.id,
        input.expectedRevision,
        "WITHDRAWN",
      );
      return updated === null
        ? err(appError("REVISION_CONFLICT", "Registration review revision conflict"))
        : ok(updated);
    });
  }

  public async requestChanges(
    input: ReviewRegistrationInput,
  ): Promise<Result<ReviewRegistrationResult>> {
    return this.decideReview(input, "REQUEST_CHANGES", "CHANGES_REQUESTED", false);
  }

  public async approve(input: ReviewRegistrationInput): Promise<Result<ReviewRegistrationResult>> {
    return this.decideReview(input, "APPROVE", "APPROVED", true);
  }

  public async reject(input: ReviewRegistrationInput): Promise<Result<ReviewRegistrationResult>> {
    return this.decideReview(input, "REJECT", "REJECTED", true);
  }

  private async decideReview(
    input: ReviewRegistrationInput,
    operation: RegistrationIdempotentOperation,
    nextStatus: RegistrationRevisionStatus,
    terminalDecision: boolean,
  ): Promise<Result<ReviewRegistrationResult>> {
    const keyResult = normalizeIdempotencyKey(input.idempotencyKey);
    if (!keyResult.ok) return keyResult;
    const key = keyResult.value;

    const adminPrincipalId = input.actor.adminPrincipalId.trim();
    if (adminPrincipalId.length === 0) {
      return err(appError("VALIDATION_FAILED", "Admin principal is required for review action"));
    }

    return this.repository.transaction(async (tx) => {
      const replay = await tx.loadIdempotencyReceipt(operation, key);
      if (replay !== null) {
        if (replay.id !== input.reviewId) {
          return err(
            appError(
              "FINGERPRINT_MISMATCH",
              "Registration idempotency key belongs to another review",
            ),
          );
        }
        return ok({ ...replay, replayed: true });
      }

      const review = await tx.loadRevisionById(input.reviewId);
      if (review === null) return err(appError("NOT_FOUND", "Registration review not found"));

      const current = await tx.loadCurrentRevision(review.playerId);
      if (current === null || current.id !== review.id) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Only the current registration review can be decided",
          ),
        );
      }
      if (current.revision !== input.expectedRevision) {
        return err(appError("REVISION_CONFLICT", "Registration review revision conflict"));
      }
      if (current.status !== "SUBMITTED") {
        return err(
          appError("INVALID_STATE_TRANSITION", "Only submitted registration can be decided"),
        );
      }

      const updated = await tx.updateRevisionStatus(
        current.id,
        input.expectedRevision,
        nextStatus,
        terminalDecision ? adminPrincipalId : undefined,
      );
      if (updated === null) {
        return err(appError("REVISION_CONFLICT", "Registration review revision conflict"));
      }

      await tx.saveIdempotencyReceipt(operation, key, updated.id);
      return ok({ ...updated, replayed: false });
    });
  }
}
