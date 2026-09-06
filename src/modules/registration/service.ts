import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  registrationConversationInvariant,
  type RegistrationConversationEditingMode,
  type RegistrationConversationField,
  type RegistrationConversationRecord,
  type RegistrationConversationState,
} from "./conversation-state.js";
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

export interface SaveRegistrationConversationCheckpointInput {
  readonly playerId: PlayerId;
  readonly chatRef: string;
  readonly state: RegistrationConversationState;
  readonly editingMode: RegistrationConversationEditingMode | null;
  readonly currentField: RegistrationConversationField | null;
  readonly editField: RegistrationConversationField | null;
  readonly activePromptOutboxIdempotencyKey: string | null;
  readonly pendingReviewId?: string | null;
  readonly pendingReviewRevision?: number | null;
  readonly expectedConversationRevision: number | null;
  readonly expectedDraftRevision: number | null;
  readonly inboxMessageId: string;
  readonly draft?: RegistrationDraftInput;
}

export interface SaveRegistrationConversationCheckpointResult {
  readonly conversation: RegistrationConversationRecord;
  readonly draft: RegistrationDraftRecord | null;
  readonly replayed: boolean;
}

export interface ResetMutableRegistrationInput {
  readonly playerId: PlayerId;
  readonly expectedConversationRevision: number;
  readonly expectedDraftRevision: number | null;
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

function sameExpectedRevision(actual: number | null, expected: number | null): boolean {
  return actual === expected;
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

  public async getConversation(
    playerId: PlayerId,
  ): Promise<Result<RegistrationConversationRecord>> {
    return this.repository.read(async (tx) => {
      const conversation = await tx.loadConversation(playerId);
      return conversation === null
        ? err(appError("NOT_FOUND", "Registration conversation not found"))
        : ok(conversation);
    });
  }

  public async saveConversationCheckpoint(
    input: SaveRegistrationConversationCheckpointInput,
  ): Promise<Result<SaveRegistrationConversationCheckpointResult>> {
    const chatRef = input.chatRef.trim();
    const inboxMessageId = input.inboxMessageId.trim();
    if (chatRef.length === 0 || inboxMessageId.length === 0) {
      return err(appError("VALIDATION_FAILED", "Registration conversation checkpoint is invalid"));
    }

    const normalizedDraft =
      input.draft === undefined ? null : normalizeRegistrationDraft(input.draft);
    if (normalizedDraft !== null && !normalizedDraft.ok) return normalizedDraft;

    return this.repository.transaction(async (tx) => {
      await tx.lockPlayer(input.playerId);
      const currentConversation = await tx.loadConversation(input.playerId);
      const currentDraft = await tx.loadDraft(input.playerId);

      if (
        currentConversation !== null &&
        currentConversation.lastInboxMessageId === inboxMessageId
      ) {
        return ok({ conversation: currentConversation, draft: currentDraft, replayed: true });
      }

      if (
        !sameExpectedRevision(
          currentConversation?.revision ?? null,
          input.expectedConversationRevision,
        ) ||
        !sameExpectedRevision(currentDraft?.revision ?? null, input.expectedDraftRevision)
      ) {
        return err(appError("REVISION_CONFLICT", "Registration conversation revision conflict"));
      }

      let savedDraft = currentDraft;
      if (normalizedDraft?.ok) {
        savedDraft = await tx.saveDraft({
          playerId: input.playerId,
          snapshot: draftCopy(normalizedDraft.value),
          expectedRevision: input.expectedDraftRevision,
        });
        if (savedDraft === null) {
          return err(appError("REVISION_CONFLICT", "Registration draft revision conflict"));
        }
      }

      let pendingReviewId = input.pendingReviewId ?? null;
      let pendingReviewRevision = input.pendingReviewRevision ?? null;
      if (
        input.state === "WITHDRAW_CONFIRM" &&
        pendingReviewId === null &&
        pendingReviewRevision === null
      ) {
        const currentReview = await tx.loadCurrentRevision(input.playerId);
        if (currentReview === null || currentReview.status !== "SUBMITTED") {
          return err(
            appError(
              "INVALID_STATE_TRANSITION",
              "No submitted registration review is available for withdrawal confirmation",
            ),
          );
        }
        pendingReviewId = currentReview.id;
        pendingReviewRevision = currentReview.revision;
      }

      const prospective: RegistrationConversationRecord = {
        playerId: input.playerId,
        chatRef,
        state: input.state,
        editingMode: input.editingMode,
        currentField: input.currentField,
        editField: input.editField,
        activePromptOutboxIdempotencyKey: input.activePromptOutboxIdempotencyKey,
        pendingReviewId,
        pendingReviewRevision,
        draftRevision: savedDraft?.revision ?? null,
        lastInboxMessageId: inboxMessageId,
        flowVersion: 2,
        revision: currentConversation === null ? 0 : currentConversation.revision + 1,
      };
      if (!registrationConversationInvariant(prospective)) {
        return err(appError("VALIDATION_FAILED", "Registration conversation state is invalid"));
      }

      const savedConversation = await tx.saveConversation({
        playerId: input.playerId,
        chatRef,
        state: input.state,
        editingMode: input.editingMode,
        currentField: input.currentField,
        editField: input.editField,
        activePromptOutboxIdempotencyKey: input.activePromptOutboxIdempotencyKey,
        pendingReviewId,
        pendingReviewRevision,
        draftRevision: savedDraft?.revision ?? null,
        lastInboxMessageId: inboxMessageId,
        expectedRevision: input.expectedConversationRevision,
      });
      if (savedConversation === null) {
        return err(appError("REVISION_CONFLICT", "Registration conversation revision conflict"));
      }

      return ok({ conversation: savedConversation, draft: savedDraft, replayed: false });
    });
  }

  public async resetMutableRegistration(
    input: ResetMutableRegistrationInput,
  ): Promise<Result<{ readonly reset: true }>> {
    return this.repository.transaction(async (tx) => {
      await tx.lockPlayer(input.playerId);
      const currentConversation = await tx.loadConversation(input.playerId);
      const currentDraft = await tx.loadDraft(input.playerId);

      if (
        !sameExpectedRevision(
          currentConversation?.revision ?? null,
          input.expectedConversationRevision,
        ) ||
        !sameExpectedRevision(currentDraft?.revision ?? null, input.expectedDraftRevision)
      ) {
        return err(appError("REVISION_CONFLICT", "Registration reset revision conflict"));
      }

      await tx.deleteConversation(input.playerId);
      await tx.deleteDraft(input.playerId);
      return ok({ reset: true as const });
    });
  }

  public async getCurrentReview(playerId: PlayerId): Promise<Result<RegistrationRevisionRecord>> {
    return this.repository.read(async (tx) => {
      const current = await tx.loadCurrentRevision(playerId);
      return current === null
        ? err(appError("NOT_FOUND", "Current registration review not found"))
        : ok(current);
    });
  }

  public async getReview(reviewId: string): Promise<Result<RegistrationRevisionRecord>> {
    return this.repository.read(async (tx) => {
      const review = await tx.loadRevisionById(reviewId);
      return review === null
        ? err(appError("NOT_FOUND", "Registration review not found"))
        : ok(review);
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
        if (
          replay.playerId !== input.playerId ||
          !sameSnapshot(replay.snapshot, validation.value)
        ) {
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
      await tx.lockPlayer(input.playerId);
      const conversation = await tx.loadConversation(input.playerId);
      if (
        conversation === null ||
        conversation.state !== "WITHDRAW_CONFIRM" ||
        conversation.pendingReviewId === null ||
        conversation.pendingReviewRevision === null ||
        conversation.pendingReviewId !== input.revisionId ||
        conversation.pendingReviewRevision !== input.expectedRevision
      ) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Registration review withdrawal is not confirmed for this exact revision",
          ),
        );
      }

      const current = await tx.loadCurrentRevision(input.playerId);
      if (
        current === null ||
        current.id !== conversation.pendingReviewId ||
        current.revision !== conversation.pendingReviewRevision ||
        current.status !== "SUBMITTED"
      ) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Submitted registration review changed after withdrawal confirmation",
          ),
        );
      }

      const updated = await tx.updateRevisionStatus(
        conversation.pendingReviewId,
        conversation.pendingReviewRevision,
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
