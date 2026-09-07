import { z } from "zod";
import type { Clock } from "../../platform/clock/index.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  CloseWorldServiceVisitInput,
  OpenWorldServiceVisitInput,
  RecordSceneProofInput,
  SceneProofRecord,
  SetWorldServiceActivePromptInput,
  WorldServiceSessionRecord,
} from "./contracts.js";
import {
  sceneProofInvalid,
  sceneProofRequired,
  worldServiceRevisionConflict,
  worldServiceVisitConflict,
  worldServiceVisitNotFound,
} from "./errors.js";
import type { WorldServiceSessionRepository } from "./ports.js";

const uuidSchema = z.string().uuid();
const boundedToken = z.string().trim().min(1).max(512);
const MAX_SCENE_TEXT_LENGTH = 32_768;

function nonEmptyLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function validUuid(label: string, value: string): Result<string> {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(sceneProofInvalid(`${label} must be a UUID`));
}

function validRevision(expectedRevision: bigint): Result<bigint> {
  return expectedRevision >= 0n
    ? ok(expectedRevision)
    : err(sceneProofInvalid("expectedRevision must be non-negative"));
}

export class WorldServiceSessionService {
  public constructor(
    private readonly repository: WorldServiceSessionRepository,
    private readonly clock: Clock,
  ) {}

  public async recordSceneProof(input: RecordSceneProofInput): Promise<Result<SceneProofRecord>> {
    const areaId = validUuid("areaId", input.areaId);
    if (!areaId.ok) return areaId;
    const sourceInboxMessageId = validUuid("sourceInboxMessageId", input.sourceInboxMessageId);
    if (!sourceInboxMessageId.ok) return sourceInboxMessageId;
    if (input.text.length > MAX_SCENE_TEXT_LENGTH) {
      return err(sceneProofInvalid("Scene text exceeds the messaging boundary"));
    }
    const lineCount = nonEmptyLineCount(input.text);
    if (lineCount < 4) {
      return err(sceneProofInvalid("Scene proof requires at least four non-empty lines"));
    }

    const createdAt = this.clock.now();
    return this.repository.transaction(async (transaction) =>
      ok(
        await transaction.insertSceneProof({
          playerId: input.playerId,
          areaId: areaId.value,
          sourceInboxMessageId: sourceInboxMessageId.value,
          lineCount,
          createdAt,
        }),
      ),
    );
  }

  public async openVisit(
    input: OpenWorldServiceVisitInput,
  ): Promise<Result<WorldServiceSessionRecord>> {
    const areaId = validUuid("areaId", input.areaId);
    if (!areaId.ok) return areaId;
    const now = this.clock.now();

    return this.repository.transaction(async (transaction) => {
      const active = await transaction.activeSession(input.playerId, true);
      if (active !== null) {
        return active.areaId === areaId.value && active.serviceKind === input.serviceKind
          ? ok(active)
          : err(worldServiceVisitConflict());
      }

      if (input.serviceKind === "PC") {
        return ok(
          await transaction.createSession({
            playerId: input.playerId,
            areaId: areaId.value,
            serviceKind: input.serviceKind,
            sceneProofId: null,
            createdAt: now,
          }),
        );
      }

      const proof = await transaction.claimSceneProof({
        playerId: input.playerId,
        areaId: areaId.value,
        consumedAt: now,
      });
      if (proof === null) return err(sceneProofRequired());

      return ok(
        await transaction.createSession({
          playerId: input.playerId,
          areaId: areaId.value,
          serviceKind: input.serviceKind,
          sceneProofId: proof.proofId,
          createdAt: now,
        }),
      );
    });
  }

  public async closeVisit(
    input: CloseWorldServiceVisitInput,
  ): Promise<Result<WorldServiceSessionRecord>> {
    const revision = validRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    const now = this.clock.now();

    return this.repository.transaction(async (transaction) => {
      const active = await transaction.activeSession(input.playerId, true);
      if (active === null) return err(worldServiceVisitNotFound());
      if (active.revision !== revision.value) {
        return err(worldServiceRevisionConflict(revision.value));
      }
      const closed = await transaction.closeSession({
        playerId: input.playerId,
        expectedRevision: revision.value,
        closedAt: now,
      });
      return closed === null ? err(worldServiceRevisionConflict(revision.value)) : ok(closed);
    });
  }

  public async loadActiveSession(
    playerId: PlayerId,
  ): Promise<Result<WorldServiceSessionRecord | null>> {
    return ok(await this.repository.read((transaction) => transaction.activeSession(playerId)));
  }

  public async setActivePrompt(
    input: SetWorldServiceActivePromptInput,
  ): Promise<Result<WorldServiceSessionRecord>> {
    const revision = validRevision(input.expectedRevision);
    if (!revision.ok) return revision;
    const outboxIdempotencyKey = boundedToken.safeParse(input.outboxIdempotencyKey);
    if (!outboxIdempotencyKey.success) {
      return err(sceneProofInvalid("outboxIdempotencyKey is invalid"));
    }
    const externalMessageId = boundedToken.safeParse(input.externalMessageId);
    if (!externalMessageId.success) {
      return err(sceneProofInvalid("externalMessageId is invalid"));
    }
    const now = this.clock.now();

    return this.repository.transaction(async (transaction) => {
      const active = await transaction.activeSession(input.playerId, true);
      if (active === null) return err(worldServiceVisitNotFound());
      if (active.revision !== revision.value) {
        const identicalReplay =
          active.revision === revision.value + 1n &&
          active.expectedReplyOutboxIdempotencyKey === outboxIdempotencyKey.data &&
          active.expectedReplyExternalMessageId === externalMessageId.data;
        return identicalReplay ? ok(active) : err(worldServiceRevisionConflict(revision.value));
      }
      const updated = await transaction.setActivePrompt({
        playerId: input.playerId,
        expectedRevision: revision.value,
        outboxIdempotencyKey: outboxIdempotencyKey.data,
        externalMessageId: externalMessageId.data,
        updatedAt: now,
      });
      return updated === null ? err(worldServiceRevisionConflict(revision.value)) : ok(updated);
    });
  }
}
