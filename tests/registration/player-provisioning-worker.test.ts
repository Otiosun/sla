import { describe, expect, it } from "vitest";
import { PlayerProvisioningWorker } from "../../src/modules/registration/provisioning-worker.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const REVIEW_A = "11111111-1111-4111-8111-111111111111";
const REVIEW_B = "22222222-2222-4222-8222-222222222222";

describe("PlayerProvisioningWorker", () => {
  it("retries durable APPROVED/PROVISIONING candidates and does not stop on one failure", async () => {
    const calls: string[] = [];
    const worker = new PlayerProvisioningWorker(
      {
        listPendingReviewIds: async () => [REVIEW_A, REVIEW_B],
      },
      {
        provisionApprovedPlayer: async (reviewId: string) => {
          calls.push(reviewId);
          return reviewId === REVIEW_A
            ? err(appError("FEATURE_UNAVAILABLE", "transient mechanical failure"))
            : ok({
                playerId: "33333333-3333-4333-8333-333333333333" as never,
                status: "ACTIVE" as const,
                approvedReviewId: REVIEW_B,
                revision: 2,
              });
        },
      },
      25,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 2,
      activated: 1,
      failed: 1,
    });
    expect(calls).toEqual([REVIEW_A, REVIEW_B]);
  });

  it("rejects an unsafe batch size", () => {
    expect(
      () =>
        new PlayerProvisioningWorker(
          { listPendingReviewIds: async () => [] },
          { provisionApprovedPlayer: async () => err(appError("ACTION_INVALID", "unused")) },
          0,
        ),
    ).toThrow(/batch size/i);
  });
});
