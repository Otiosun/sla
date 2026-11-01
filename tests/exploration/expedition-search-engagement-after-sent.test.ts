import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EncounterService } from "../../src/modules/encounter/service.js";
import type { EncounterView } from "../../src/modules/encounter/contracts.js";
import { ExpeditionSearchEngagementAfterSent } from "../../src/modules/exploration/expedition-search-engagement-after-sent.js";
import type { DeliveredExpeditionEncounter } from "../../src/platform/exploration/postgres-expedition-search-sent-proof.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const incoming = {
  playerId,
  encounterId: randomUUID(),
  outcomeId: randomUUID(),
  outboxMessageId: randomUUID(),
  destinationRef: "5579999999999@s.whatsapp.net",
};
const confirmed: DeliveredExpeditionEncounter = {
  playerId,
  encounterId: incoming.encounterId,
  outcomeId: incoming.outcomeId,
  areaId: randomUUID(),
  encounterStatus: "CREATED",
  encounterRevision: 0n,
};

function setup(proven: DeliveredExpeditionEncounter = confirmed) {
  const confirm = vi.fn(async () => ok(proven));
  const observe = vi.fn(async () =>
    ok({
      playerId,
      encounterId: proven.encounterId,
      areaId: proven.areaId,
      status: "PRESENTED" as const,
      revision: 1n,
    } as EncounterView),
  );
  const engage = vi.fn(async () =>
    ok({
      playerId,
      encounterId: proven.encounterId,
      areaId: proven.areaId,
      status: "ENGAGED" as const,
      revision: 2n,
    } as EncounterView),
  );
  const worker = new ExpeditionSearchEngagementAfterSent({ confirm }, {
    observe,
    engage,
  } as unknown as Pick<EncounterService, "observe" | "engage">);
  return { confirm, observe, engage, worker };
}

describe("V4 staging-only canonical encounter lifecycle after SENT", () => {
  it("observes then engages the SAME encounter only after the trusted delivery proof", async () => {
    const f = setup();
    const result = await f.worker.engageAfterSent(incoming);
    expect(result).toMatchObject({
      ok: true,
      value: {
        encounterId: incoming.encounterId,
        encounterStatus: "ENGAGED",
        encounterRevision: 2n,
      },
    });
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith({
      playerId,
      encounterId: incoming.encounterId,
      expectedRevision: 0n,
    });
    expect(f.engage).toHaveBeenCalledExactlyOnceWith({
      playerId,
      encounterId: incoming.encounterId,
      expectedRevision: 1n,
    });
  });

  it("does not observe or engage without the exact SENT proof", async () => {
    const f = setup();
    f.confirm.mockResolvedValueOnce(err(appError("FLOW_BLOCKED", "Outbox not sent")) as never);
    expect(await f.worker.engageAfterSent(incoming)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.engage).not.toHaveBeenCalled();
  });

  it("does not observe twice when already PRESENTED", async () => {
    const f = setup({ ...confirmed, encounterStatus: "PRESENTED", encounterRevision: 1n });
    expect((await f.worker.engageAfterSent(incoming)).ok).toBe(true);
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.engage).toHaveBeenCalledExactlyOnceWith({
      playerId,
      encounterId: incoming.encounterId,
      expectedRevision: 1n,
    });
  });

  it("reuses ENGAGED status without issuing another mutation", async () => {
    const f = setup({ ...confirmed, encounterStatus: "ENGAGED", encounterRevision: 2n });
    expect(await f.worker.engageAfterSent(incoming)).toMatchObject({
      ok: true,
      value: { encounterStatus: "ENGAGED", encounterRevision: 2n },
    });
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.engage).not.toHaveBeenCalled();
  });

  it("fails closed if presented encounter belongs to another trainer or area", async () => {
    const f = setup();
    f.observe.mockResolvedValueOnce(
      ok({
        playerId: createPlayerId(),
        encounterId: confirmed.encounterId,
        areaId: confirmed.areaId,
        status: "PRESENTED",
        revision: 1n,
      } as EncounterView),
    );
    expect((await f.worker.engageAfterSent(incoming)).ok).toBe(false);
    expect(f.engage).not.toHaveBeenCalled();

    f.observe.mockResolvedValueOnce(
      ok({
        playerId,
        encounterId: confirmed.encounterId,
        areaId: randomUUID(),
        status: "PRESENTED",
        revision: 1n,
      } as EncounterView),
    );
    expect((await f.worker.engageAfterSent(incoming)).ok).toBe(false);
    expect(f.engage).not.toHaveBeenCalled();
  });

  it("does not bypass canonical revision conflicts", async () => {
    const f = setup();
    f.observe.mockResolvedValueOnce(err(appError("REVISION_CONFLICT", "stale")) as never);
    expect(await f.worker.engageAfterSent(incoming)).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(f.engage).not.toHaveBeenCalled();
  });

  it("does not issue a menu, capture attempt, spawn or battle on lifecycle confirmation", async () => {
    const f = setup();
    expect((await f.worker.engageAfterSent(incoming)).ok).toBe(true);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.engage).toHaveBeenCalledOnce();
  });
});
