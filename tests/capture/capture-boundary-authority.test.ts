import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CaptureAttemptInputBoundarySchema } from "../../src/modules/capture/contracts.js";
import {
  createCorrelationId,
  createEncounterId,
  createPlayerId,
} from "../../src/shared-kernel/ids.js";

describe("Capture public boundary authority", () => {
  it("rejects client-controlled explicit capture modifiers", () => {
    const valid = {
      playerId: createPlayerId(),
      encounterId: createEncounterId(),
      expectedEncounterRevision: 0n,
      expectedBattleVersion: null,
      ballItemId: randomUUID(),
      idempotencyKey: "boundary-authority",
      correlationId: createCorrelationId(),
      causationId: null,
    };

    expect(CaptureAttemptInputBoundarySchema.safeParse(valid).success).toBe(true);
    expect(
      CaptureAttemptInputBoundarySchema.safeParse({
        ...valid,
        explicitModifierBasisPoints: [100_000],
      }).success,
    ).toBe(false);
  });
});
