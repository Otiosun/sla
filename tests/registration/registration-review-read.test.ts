import { describe, expect, it } from "vitest";
import { RegistrationService } from "../../src/modules/registration/service.js";
import type {
  RegistrationRepository,
  RegistrationRevisionRecord,
  RegistrationTransaction,
} from "../../src/modules/registration/ports.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const REVIEW_ID = "33333333-3333-4333-8333-333333333333";

function repositoryWith(review: RegistrationRevisionRecord): RegistrationRepository {
  const tx: RegistrationTransaction = {
    loadDraft: async () => null,
    saveDraft: async () => null,
    loadCurrentRevision: async () => review,
    loadRevisionById: async (revisionId) => (revisionId === review.id ? review : null),
    loadIdempotencyReceipt: async () => null,
    insertRevision: async () => review,
    saveIdempotencyReceipt: async () => {},
    updateRevisionStatus: async () => null,
  };
  return {
    read: async (work) => work(tx),
    transaction: async (work) => work(tx),
  };
}

describe("RegistrationService exact review lookup", () => {
  it("loads the immutable review directly by review id and fails closed for an unknown id", async () => {
    const playerId = createPlayerId();
    const review: RegistrationRevisionRecord = {
      id: REVIEW_ID,
      playerId,
      sequenceNo: 2,
      status: "SUBMITTED",
      snapshot: {
        trainerName: "Liora Vale",
        age: 17,
        genderPronouns: "ela/dela",
        appearance: "Casaco de viagem.",
        personality: "Curiosa.",
        backstory: "Pesquisadora iniciante.",
        starterFormId: "22222222-2222-4222-8222-222222222222",
        regionId: "11111111-1111-4111-8111-111111111111",
        schemaVersion: 1,
      },
      revision: 4,
    };
    const service = new RegistrationService(repositoryWith(review));

    expect(await service.getReview(REVIEW_ID)).toEqual({ ok: true, value: review });
    expect(await service.getReview("99999999-9999-4999-8999-999999999999")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});
