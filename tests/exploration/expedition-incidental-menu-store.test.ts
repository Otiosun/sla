import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StoredIncidentalCaptureDispatch } from "../../src/modules/exploration/expedition-incidental-menu-store.js";
import { ExpeditionIncidentalCaptureAction } from "../../src/modules/exploration/expedition-incidental-capture-action.js";
import { renderExpeditionV4IncidentalPanel } from "../../src/modules/exploration/expedition-v4-incidental-panel.js";
import { createCorrelationId, createPlayerId, type EncounterId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const otherPlayerId = createPlayerId();
const encounterId = randomUUID() as EncounterId;
const outcomeId = randomUUID();
const menuId = randomUUID();
const ballItemId = randomUUID();
const rendered = renderExpeditionV4IncidentalPanel({
  source: "INCIDENTAL", encounterStatus: "ENGAGED", encounterId, encounterRevision: 3n,
  speciesName: "Zigzagoon", level: 5, canBattle: true,
  balls: [{ kind: "POKE", quantity: 2, captureAuthorized: true }],
  canIgnore: true, ignoreMinutes: 10, combiningCount: 0,
});
if (!rendered.ok) throw new Error("Test setup failed");
const issued = {
  id: menuId, playerId, encounterId, encounterRevision: 3n, outcomeId,
  snapshot: { outcomeId, menu: rendered.value, ballItemIds: { POKE: ballItemId } },
};
function setup() {
  const load = vi.fn(async (player: typeof playerId, id: string) =>
    player === playerId && id === menuId ? issued : null);
  const authorize = { belongsToPlayer: vi.fn(async () => true) };
  const result = {
    captureAttemptId: randomUUID(), encounterId, battleId: null,
    status: "FAILED" as const, probabilityBasisPoints: 2000,
    rollBasisPoints: 9000, pokemonInstanceId: null, placement: null,
    replayed: false as const, events: [],
  };
  const capture = { attempt: vi.fn(async () => ok(result)) };
  const dispatcher = new StoredIncidentalCaptureDispatch(
    { load }, new ExpeditionIncidentalCaptureAction(authorize, capture),
  );
  const input = {
    playerId, menuId, rawChoice: "2", expectedEncounterId: encounterId,
    expectedEncounterRevision: 3n, idempotencyKey: "inbox:123",
    correlationId: createCorrelationId(), causationId: null,
  };
  return { dispatcher, input, load, authorize, capture, result };
}
describe("Durable incidental menu dispatch, shadow only", () => {
  it("loads only the server-issued menu and delegates unchanged inbox idempotency", async () => {
    const { dispatcher, input, capture, result } = setup();
    expect(await dispatcher.execute(input)).toEqual(ok(result));
    expect(await dispatcher.execute(input)).toEqual(ok(result));
    expect(capture.attempt).toHaveBeenCalledTimes(2);
    expect(capture.attempt.mock.calls[0]?.[0].ballItemId).toBe(ballItemId);
    expect(capture.attempt.mock.calls[1]?.[0].idempotencyKey).toBe("inbox:123");
  });
  it("does not leak menus across players or guessed menu IDs", async () => {
    const { dispatcher, input, capture, authorize } = setup();
    expect((await dispatcher.execute({ ...input, playerId: otherPlayerId })).ok).toBe(false);
    expect((await dispatcher.execute({ ...input, menuId: randomUUID() })).ok).toBe(false);
    expect(capture.attempt).not.toHaveBeenCalled();
    expect(authorize.belongsToPlayer).not.toHaveBeenCalled();
  });
  it("rejects stale revision and unoffered numeric actions", async () => {
    const { dispatcher, input, capture } = setup();
    expect((await dispatcher.execute({ ...input, expectedEncounterRevision: 4n })).ok).toBe(false);
    expect((await dispatcher.execute({ ...input, rawChoice: "4" })).ok).toBe(false);
    expect((await dispatcher.execute({ ...input, rawChoice: "1" })).ok).toBe(false);
    expect(capture.attempt).not.toHaveBeenCalled();
  });
});
