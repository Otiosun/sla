import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CaptureAttemptInputBoundarySchema } from "../../src/modules/capture/contracts.js";
import {
  createCorrelationId,
  createEncounterId,
  createPlayerId,
} from "../../src/shared-kernel/ids.js";

function validBoundaryRequest() {
  return {
    playerId: createPlayerId(),
    encounterId: createEncounterId(),
    expectedEncounterRevision: 0n,
    expectedBattleVersion: null,
    ballItemId: randomUUID(),
    idempotencyKey: "boundary-authority",
    correlationId: createCorrelationId(),
    causationId: null,
  };
}

describe("Capture public boundary authority", () => {
  it("accepts the canonical public capture request", () => {
    expect(CaptureAttemptInputBoundarySchema.safeParse(validBoundaryRequest()).success).toBe(true);
  });

  it("rejects client-controlled explicit capture modifiers", () => {
    expect(
      CaptureAttemptInputBoundarySchema.safeParse({
        ...validBoundaryRequest(),
        explicitModifierBasisPoints: [100_000],
      }).success,
    ).toBe(false);
  });
});
