import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type {
  SceneProofRecord,
  WorldServiceSessionRecord,
} from "../../src/modules/world-services/contracts.js";
import type {
  WorldServiceSessionRepository,
  WorldServiceSessionTransaction,
} from "../../src/modules/world-services/ports.js";
import { WorldServiceSessionService } from "../../src/modules/world-services/session-service.js";

class FakeWorldServiceSessionRepository implements WorldServiceSessionRepository {
  readonly proofs: SceneProofRecord[] = [];
  readonly sessions: WorldServiceSessionRecord[] = [];

  async transaction<T>(
    work: (transaction: WorldServiceSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this.transactionView());
  }

  async read<T>(work: (transaction: WorldServiceSessionTransaction) => Promise<T>): Promise<T> {
    return work(this.transactionView());
  }

  private transactionView(): WorldServiceSessionTransaction {
    return {
      insertSceneProof: async (input) => {
        const proof: SceneProofRecord = {
          proofId: `proof-${this.proofs.length + 1}`,
          playerId: input.playerId,
          areaId: input.areaId,
          sourceInboxMessageId: input.sourceInboxMessageId,
          lineCount: input.lineCount,
          createdAt: input.createdAt,
          consumedAt: null,
        };
        this.proofs.push(proof);
        return proof;
      },
      claimSceneProof: async (input) => {
        const index = this.proofs.findIndex(
          (proof) =>
            proof.playerId === input.playerId &&
            proof.areaId === input.areaId &&
            proof.consumedAt === null,
        );
        const proof = this.proofs[index];
        if (index < 0 || proof === undefined) return null;
        const consumed: SceneProofRecord = { ...proof, consumedAt: input.consumedAt };
        this.proofs[index] = consumed;
        return consumed;
      },
      activeSession: async (playerId) =>
        this.sessions.find(
          (session) => session.playerId === playerId && session.closedAt === null,
        ) ?? null,
      createSession: async (input) => {
        const session: WorldServiceSessionRecord = {
          sessionId: `session-${this.sessions.length + 1}`,
          playerId: input.playerId,
          areaId: input.areaId,
          serviceKind: input.serviceKind,
          state: "OPEN",
          sceneProofId: input.sceneProofId,
          expectedReplyOutboxIdempotencyKey: null,
          expectedReplyExternalMessageId: null,
          revision: 0n,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          closedAt: null,
        };
        this.sessions.push(session);
        return session;
      },
      closeSession: async (input) => {
        const index = this.sessions.findIndex(
          (session) =>
            session.playerId === input.playerId &&
            session.closedAt === null &&
            session.revision === input.expectedRevision,
        );
        const session = this.sessions[index];
        if (index < 0 || session === undefined) return null;
        const closed: WorldServiceSessionRecord = {
          ...session,
          state: "CLOSED",
          revision: session.revision + 1n,
          updatedAt: input.closedAt,
          closedAt: input.closedAt,
        };
        this.sessions[index] = closed;
        return closed;
      },
      setActivePrompt: async (input) => {
        const index = this.sessions.findIndex(
          (session) =>
            session.playerId === input.playerId &&
            session.closedAt === null &&
            session.revision === input.expectedRevision,
        );
        const session = this.sessions[index];
        if (index < 0 || session === undefined) return null;
        const updated: WorldServiceSessionRecord = {
          ...session,
          expectedReplyOutboxIdempotencyKey: input.outboxIdempotencyKey,
          expectedReplyExternalMessageId: input.externalMessageId,
          revision: session.revision + 1n,
          updatedAt: input.updatedAt,
        };
        this.sessions[index] = updated;
        return updated;
      },
    };
  }
}

function player(): PlayerId {
  return createPlayerId();
}

const AREA_A = "00000000-0000-4000-8000-000000000101";
const AREA_B = "00000000-0000-4000-8000-000000000102";

function fixture() {
  const repository = new FakeWorldServiceSessionRepository();
  const clock = new ManualClock(new Date("2026-09-07T03:00:00.000Z"));
  return { repository, clock, service: new WorldServiceSessionService(repository, clock) };
}

describe("WorldServiceSessionService", () => {
  it("rejects scene proof with fewer than four non-empty lines and persists no prose", async () => {
    const { repository, service } = fixture();
    const playerId = player();

    const rejected = await service.recordSceneProof({
      playerId,
      areaId: AREA_A,
      sourceInboxMessageId: "00000000-0000-4000-8000-000000000201",
      text: "linha 1\n\nlinha 2\nlinha 3",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("VALIDATION_FAILED");
    expect(repository.proofs).toHaveLength(0);

    const accepted = await service.recordSceneProof({
      playerId,
      areaId: AREA_A,
      sourceInboxMessageId: "00000000-0000-4000-8000-000000000202",
      text: "linha 1\nlinha 2\n\nlinha 3\n linha 4 ",
    });
    expect(accepted.ok).toBe(true);
    expect(repository.proofs).toHaveLength(1);
    expect(repository.proofs[0]?.lineCount).toBe(4);
    expect(repository.proofs[0]).not.toHaveProperty("text");
  });

  it("requires an unconsumed proof from the same area and consumes it exactly once", async () => {
    const { repository, service } = fixture();
    const playerId = player();

    await service.recordSceneProof({
      playerId,
      areaId: AREA_A,
      sourceInboxMessageId: "00000000-0000-4000-8000-000000000203",
      text: "1\n2\n3\n4",
    });

    const wrongArea = await service.openVisit({
      playerId,
      areaId: AREA_B,
      serviceKind: "POKEMART",
    });
    expect(wrongArea.ok).toBe(false);
    expect(repository.proofs[0]?.consumedAt).toBeNull();

    const opened = await service.openVisit({
      playerId,
      areaId: AREA_A,
      serviceKind: "POKEMART",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.serviceKind).toBe("POKEMART");
    expect(opened.value.sceneProofId).toBe(repository.proofs[0]?.proofId);
    expect(repository.proofs[0]?.consumedAt).not.toBeNull();

    const closed = await service.closeVisit({
      playerId,
      expectedRevision: opened.value.revision,
    });
    expect(closed.ok).toBe(true);

    const replayWithoutProof = await service.openVisit({
      playerId,
      areaId: AREA_A,
      serviceKind: "POKEMON_CENTER",
    });
    expect(replayWithoutProof.ok).toBe(false);
  });

  it("does not consume another proof when the same active visit is opened again", async () => {
    const { repository, service } = fixture();
    const playerId = player();

    for (const sourceInboxMessageId of [
      "00000000-0000-4000-8000-000000000204",
      "00000000-0000-4000-8000-000000000205",
    ]) {
      await service.recordSceneProof({
        playerId,
        areaId: AREA_A,
        sourceInboxMessageId,
        text: "1\n2\n3\n4",
      });
    }

    const first = await service.openVisit({
      playerId,
      areaId: AREA_A,
      serviceKind: "POKEMON_CENTER",
    });
    const replay = await service.openVisit({
      playerId,
      areaId: AREA_A,
      serviceKind: "POKEMON_CENTER",
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value.sessionId).toBe(first.value.sessionId);
    expect(repository.proofs.filter((proof) => proof.consumedAt !== null)).toHaveLength(1);
  });

  it("persists exact active prompt identity with optimistic revision checks", async () => {
    const { service } = fixture();
    const playerId = player();
    await service.recordSceneProof({
      playerId,
      areaId: AREA_A,
      sourceInboxMessageId: "00000000-0000-4000-8000-000000000206",
      text: "1\n2\n3\n4",
    });
    const opened = await service.openVisit({
      playerId,
      areaId: AREA_A,
      serviceKind: "POKEMART",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const prompted = await service.setActivePrompt({
      playerId,
      expectedRevision: opened.value.revision,
      outboxIdempotencyKey: "world-service:prompt:1",
      externalMessageId: "WA-OUT-1",
    });
    expect(prompted.ok).toBe(true);
    if (!prompted.ok) return;
    expect(prompted.value.expectedReplyOutboxIdempotencyKey).toBe("world-service:prompt:1");
    expect(prompted.value.expectedReplyExternalMessageId).toBe("WA-OUT-1");

    const stale = await service.setActivePrompt({
      playerId,
      expectedRevision: opened.value.revision,
      outboxIdempotencyKey: "world-service:prompt:stale",
      externalMessageId: "WA-OUT-STALE",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("REVISION_CONFLICT");
  });
});
