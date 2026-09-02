import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RegistrationService } from "../../src/modules/registration/service.js";
import type {
  RegistrationDraftRecord,
  RegistrationRepository,
  RegistrationRevisionRecord,
  RegistrationTransaction,
} from "../../src/modules/registration/ports.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_FORM_ID = "22222222-2222-4222-8222-222222222222";

function snapshot() {
  return {
    trainerName: "Liora Vale",
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa, cautelosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: STARTER_FORM_ID,
    regionId: REGION_ID,
    schemaVersion: 1,
  } as const;
}

class InMemoryRegistrationRepository implements RegistrationRepository {
  public draft: RegistrationDraftRecord | null = null;
  public revisions: RegistrationRevisionRecord[] = [];
  public receipts = new Map<string, string>();

  private readonly tx: RegistrationTransaction = {
    loadDraft: async () => this.draft,
    saveDraft: async (input) => {
      const currentRevision = this.draft?.revision ?? null;
      if (currentRevision !== input.expectedRevision) return null;
      const nextRevision = (currentRevision ?? -1) + 1;
      this.draft = {
        playerId: input.playerId,
        snapshot: input.snapshot,
        revision: nextRevision,
      };
      return this.draft;
    },
    loadCurrentRevision: async () => this.revisions.at(-1) ?? null,
    loadRevisionById: async (revisionId) =>
      this.revisions.find((entry) => entry.id === revisionId) ?? null,
    loadIdempotencyReceipt: async (operation, idempotencyKey) => {
      const revisionId = this.receipts.get(`${operation}:${idempotencyKey}`);
      return revisionId === undefined
        ? null
        : (this.revisions.find((entry) => entry.id === revisionId) ?? null);
    },
    insertRevision: async (input) => {
      const record: RegistrationRevisionRecord = {
        id: randomUUID(),
        playerId: input.playerId,
        sequenceNo: input.sequenceNo,
        status: "SUBMITTED",
        snapshot: input.snapshot,
        revision: 0,
      };
      this.revisions.push(record);
      return record;
    },
    saveIdempotencyReceipt: async (operation, idempotencyKey, revisionId) => {
      this.receipts.set(`${operation}:${idempotencyKey}`, revisionId);
    },
    updateRevisionStatus: async (revisionId, expectedRevision, status) => {
      const index = this.revisions.findIndex((entry) => entry.id === revisionId);
      if (index === -1) return null;
      const current = this.revisions[index];
      if (current === undefined || current.revision !== expectedRevision) return null;
      const updated: RegistrationRevisionRecord = {
        ...current,
        status,
        revision: current.revision + 1,
      };
      this.revisions[index] = updated;
      return updated;
    },
  };

  public async transaction<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx);
  }

  public async read<T>(fn: (tx: RegistrationTransaction) => Promise<T>): Promise<T> {
    return fn(this.tx);
  }
}

describe("registration draft lifecycle", () => {
  it("persists an incomplete guided draft but refuses to submit it", async () => {
    const repository = new InMemoryRegistrationRepository();
    const service = new RegistrationService(repository);
    const playerId = createPlayerId();

    const saved = await service.saveDraft({
      playerId,
      draft: {
        trainerName: "Liora Vale",
        age: 17,
        regionId: REGION_ID,
        schemaVersion: 1,
      },
      expectedRevision: null,
    });

    expect(saved).toMatchObject({
      ok: true,
      value: {
        revision: 0,
        snapshot: { trainerName: "Liora Vale", age: 17, regionId: REGION_ID },
      },
    });
    expect(await service.submit({ playerId, idempotencyKey: "partial-submit" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(repository.revisions).toHaveLength(0);
  });

  it("reads the persisted partial draft and its optimistic revision", async () => {
    const repository = new InMemoryRegistrationRepository();
    const service = new RegistrationService(repository);
    const playerId = createPlayerId();

    await service.saveDraft({
      playerId,
      draft: { trainerName: "Liora Vale", regionId: REGION_ID, schemaVersion: 1 },
      expectedRevision: null,
    });

    expect(await service.getDraft(playerId)).toMatchObject({
      ok: true,
      value: {
        playerId,
        revision: 0,
        snapshot: { trainerName: "Liora Vale", regionId: REGION_ID, schemaVersion: 1 },
      },
    });
  });

  it("persists a draft with optimistic revision and rejects a stale save", async () => {
    const repository = new InMemoryRegistrationRepository();
    const service = new RegistrationService(repository);
    const playerId = createPlayerId();

    const first = await service.saveDraft({
      playerId,
      draft: snapshot(),
      expectedRevision: null,
    });
    expect(first).toMatchObject({ ok: true, value: { revision: 0 } });

    const stale = await service.saveDraft({
      playerId,
      draft: { ...snapshot(), trainerName: "Outra" },
      expectedRevision: null,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
  });

  it("submits one immutable revision and replays the same idempotency key", async () => {
    const repository = new InMemoryRegistrationRepository();
    const service = new RegistrationService(repository);
    const playerId = createPlayerId();

    await service.saveDraft({ playerId, draft: snapshot(), expectedRevision: null });

    const first = await service.submit({ playerId, idempotencyKey: "msg-confirm-1" });
    const replay = await service.submit({ playerId, idempotencyKey: "msg-confirm-1" });

    expect(first).toMatchObject({
      ok: true,
      value: { sequenceNo: 1, status: "SUBMITTED", replayed: false },
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { sequenceNo: 1, status: "SUBMITTED", replayed: true },
    });
    expect(repository.revisions).toHaveLength(1);

    repository.draft =
      repository.draft === null
        ? null
        : {
            ...repository.draft,
            snapshot: { ...repository.draft.snapshot, trainerName: "Mutado" },
          };

    expect(repository.revisions[0]?.snapshot.trainerName).toBe("Liora Vale");
  });

  it("withdraws the current submitted revision before editing again", async () => {
    const repository = new InMemoryRegistrationRepository();
    const service = new RegistrationService(repository);
    const playerId = createPlayerId();

    await service.saveDraft({ playerId, draft: snapshot(), expectedRevision: null });
    const submitted = await service.submit({ playerId, idempotencyKey: "msg-confirm-2" });
    if (!submitted.ok) throw submitted.error;

    const withdrawn = await service.withdraw({
      playerId,
      revisionId: submitted.value.id,
      expectedRevision: submitted.value.revision,
    });

    expect(withdrawn).toMatchObject({
      ok: true,
      value: { status: "WITHDRAWN", revision: 1 },
    });
  });
});
