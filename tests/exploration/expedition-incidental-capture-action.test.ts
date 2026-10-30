import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ExpeditionIncidentalCaptureAction,
} from "../../src/modules/exploration/expedition-incidental-capture-action.js";
import {
  renderExpeditionV4IncidentalPanel,
} from "../../src/modules/exploration/expedition-v4-incidental-panel.js";
import { createCorrelationId, createPlayerId, type EncounterId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";
import type { CaptureAttemptInput } from "../../src/modules/capture/contracts.js";

const playerId = createPlayerId();
const correlationId = createCorrelationId();
const encounterId = randomUUID() as EncounterId;
const outcomeId = randomUUID();
const pokeBallItemId = randomUUID();
const greatBallItemId = randomUUID();

function setup() {
  const view = renderExpeditionV4IncidentalPanel({
    source: "INCIDENTAL",
    encounterStatus: "ENGAGED",
    encounterId,
    encounterRevision: 4n,
    speciesName: "Zigzagoon",
    level: 6,
    canBattle: true,
    balls: [
      { kind: "POKE", quantity: 3, captureAuthorized: true },
      { kind: "GREAT", quantity: 1, captureAuthorized: true },
      { kind: "ULTRA", quantity: 0, captureAuthorized: true },
    ],
    canIgnore: true,
    ignoreMinutes: 10,
    combiningCount: 0,
  });
  if (!view.ok) throw new Error("Invalid incidental test menu");
  const authorize = { belongsToPlayer: vi.fn(async () => true) };
  const captureResult = {
    captureAttemptId: randomUUID(), encounterId, battleId: null,
    status: "FAILED" as const, probabilityBasisPoints: 4200,
    rollBasisPoints: 6500, pokemonInstanceId: null, placement: null,
    replayed: false as const, events: [],
  };
  const capture = { attempt: vi.fn(async (_input: CaptureAttemptInput) => ok(captureResult)) };
  const action = new ExpeditionIncidentalCaptureAction(authorize, capture);
  const base = {
    playerId, rawChoice: "2", expectedEncounterId: encounterId,
    expectedEncounterRevision: 4n, idempotencyKey: "inbox:original-message-id",
    correlationId, causationId: null,
    snapshot: {
      menu: view.value, outcomeId,
      ballItemIds: { POKE: pokeBallItemId, GREAT: greatBallItemId },
    },
  };
  return { action, base, authorize, capture, captureResult };
}

describe("V4 incidental Ball choice: no second capture engine", () => {
  it("selects a canonical item from the server-owned menu and calls CaptureService once", async () => {
    const { action, base, authorize, capture, captureResult } = setup();
    expect(await action.execute(base)).toEqual(ok(captureResult));
    expect(authorize.belongsToPlayer).toHaveBeenCalledWith({
      playerId, encounterId, outcomeId,
    });
    expect(capture.attempt).toHaveBeenCalledExactlyOnceWith({
      playerId, encounterId,
      expectedEncounterRevision: 4n,
      expectedBattleVersion: null, targetWildNo: 1,
      ballItemId: pokeBallItemId,
      idempotencyKey: "inbox:original-message-id",
      correlationId, causationId: null,
    });
    const great = { ...base, rawChoice: "3", idempotencyKey: "inbox:second-message" };
    expect((await action.execute(great)).ok).toBe(true);
    expect(capture.attempt.mock.calls[1]?.[0].ballItemId).toBe(greatBallItemId);
  });

  it("does not change the inbox idempotency key when the same message is delivered twice", async () => {
    const { action, base, capture } = setup();
    const first = await action.execute(base);
    const replay = await action.execute(base);
    expect(first).toEqual(replay);
    expect(capture.attempt).toHaveBeenCalledTimes(2);
    expect(capture.attempt.mock.calls[0]?.[0].idempotencyKey)
      .toBe(capture.attempt.mock.calls[1]?.[0].idempotencyKey);
    // Real CaptureService handles replay BEFORE current stock/revision changes.
    // The bridge forwards the original inbound message key unchanged.
  });

  it("rejects obsolete encounter revisions and IDs before owner/stock lookup", async () => {
    const { action, base, authorize, capture } = setup();
    for (const changed of [
      { ...base, expectedEncounterRevision: 5n },
      { ...base, expectedEncounterId: randomUUID() as EncounterId },
      { ...base, rawChoice: "4" }, // Ultra stock zero: not an offered option
      { ...base, rawChoice: "0" }, // IGNORE must never invoke CaptureService
      { ...base, rawChoice: "1" }, // BATTLE remains PvE's responsibility
      { ...base, rawChoice: "capturar" },
      { ...base, rawChoice: "2 3" },
    ]) {
      expect((await action.execute(changed)).ok).toBe(false);
    }
    expect(authorize.belongsToPlayer).not.toHaveBeenCalled();
    expect(capture.attempt).not.toHaveBeenCalled();
  });

  it("refuses a missing mapping, unauthorized outcome and unsafe idempotency", async () => {
    const { action, base, authorize, capture } = setup();
    expect((await action.execute({
      ...base, snapshot: { ...base.snapshot, ballItemIds: {} },
    })).ok).toBe(false);
    authorize.belongsToPlayer.mockResolvedValueOnce(false);
    expect((await action.execute(base)).ok).toBe(false);
    expect((await action.execute({ ...base, idempotencyKey: " " })).ok).toBe(false);
    expect(capture.attempt).not.toHaveBeenCalled();
  });
});
