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
    updateRevisionStatus: async (
      revisionId,
      expectedRevision,
      status,
      decidedByAdminPrincipalId,
    ) => {
      const index = this.revisions.findIndex((entry) => entry.id === revisionId);
      if (index === -1) return null;
      const current = this.revisions[index];
      if (current === undefined || current.revision !== expectedRevision) return null;
      const updated: RegistrationRevisionRecord = {
        ...current,
        status,
        revision: current.revision + 1,
        ...(decidedByAdminPrincipalId === undefined ? {} : { decidedByAdminPrincipalId }),
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

async function submittedFixture() {
  const repository = new InMemoryRegistrationRepository();
  const service = new RegistrationService(repository);
  const playerId = createPlayerId();
  const saved = await service.saveDraft({ playerId, draft: snapshot(), expectedRevision: null });
  if (!saved.ok) throw saved.error;
  const submitted = await service.submit({ playerId, idempotencyKey: `submit:${randomUUID()}` });
  if (!submitted.ok) throw submitted.error;
  return { repository, service, playerId, submitted: submitted.value };
}

describe("registration administrative review", () => {
  it("allows only the current submitted review to be decided", async () => {
    const { service, playerId, submitted } = await submittedFixture();
    const withdrawn = await service.withdraw({
      playerId,
      revisionId: submitted.id,
      expectedRevision: submitted.revision,
    });
    if (!withdrawn.ok) throw withdrawn.error;

    const approval = await service.approve({
      reviewId: submitted.id,
      expectedRevision: withdrawn.value.revision,
      actor: { adminPrincipalId: "admin-a" },
      idempotencyKey: "approve-withdrawn",
    });

    expect(approval).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });

  it("lets exactly one admin win a concurrent decision", async () => {
    const { service, submitted } = await submittedFixture();

    const [approval, rejection] = await Promise.all([
      service.approve({
        reviewId: submitted.id,
        expectedRevision: submitted.revision,
        actor: { adminPrincipalId: "admin-a" },
        idempotencyKey: "race-approve",
      }),
      service.reject({
        reviewId: submitted.id,
        expectedRevision: submitted.revision,
        actor: { adminPrincipalId: "admin-b" },
        idempotencyKey: "race-reject",
      }),
    ]);

    const results = [approval, rejection];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
  });

  it("replays an identical approval idempotently", async () => {
    const { repository, service, submitted } = await submittedFixture();
    const input = {
      reviewId: submitted.id,
      expectedRevision: submitted.revision,
      actor: { adminPrincipalId: "admin-a" },
      idempotencyKey: "approve-repeat",
    } as const;

    const first = await service.approve(input);
    const replay = await service.approve(input);

    expect(first).toMatchObject({
      ok: true,
      value: { status: "APPROVED", replayed: false, decidedByAdminPrincipalId: "admin-a" },
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { status: "APPROVED", replayed: true, decidedByAdminPrincipalId: "admin-a" },
    });
    expect(repository.revisions).toHaveLength(1);
  });

  it("refuses idempotency-key reuse for a different review", async () => {
    const fixture = await submittedFixture();
    const first = await fixture.service.approve({
      reviewId: fixture.submitted.id,
      expectedRevision: fixture.submitted.revision,
      actor: { adminPrincipalId: "admin-a" },
      idempotencyKey: "shared-key",
    });
    if (!first.ok) throw first.error;

    const second = await fixture.service.submit({
      playerId: fixture.playerId,
      idempotencyKey: "submit-second-review",
    });
    if (!second.ok) throw second.error;

    const collision = await fixture.service.approve({
      reviewId: second.value.id,
      expectedRevision: second.value.revision,
      actor: { adminPrincipalId: "admin-a" },
      idempotencyKey: "shared-key",
    });

    expect(collision).toMatchObject({
      ok: false,
      error: { code: "FINGERPRINT_MISMATCH" },
    });
  });

  it("requests changes without mutating the submitted snapshot", async () => {
    const { service, submitted } = await submittedFixture();

    const result = await service.requestChanges({
      reviewId: submitted.id,
      expectedRevision: submitted.revision,
      actor: { adminPrincipalId: "admin-reviewer" },
      idempotencyKey: "changes-1",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "CHANGES_REQUESTED",
        snapshot: { trainerName: "Liora Vale", starterFormId: STARTER_FORM_ID },
      },
    });
  });

  it("rejects without creating another revision or changing the draft", async () => {
    const { repository, service, submitted } = await submittedFixture();
    const draftBefore = repository.draft;

    const result = await service.reject({
      reviewId: submitted.id,
      expectedRevision: submitted.revision,
      actor: { adminPrincipalId: "admin-b" },
      idempotencyKey: "reject-1",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { status: "REJECTED", decidedByAdminPrincipalId: "admin-b" },
    });
    expect(repository.revisions).toHaveLength(1);
    expect(repository.draft).toEqual(draftBefore);
  });
});
