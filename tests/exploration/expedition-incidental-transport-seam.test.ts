import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ExpeditionIncidentalTransportSeam,
} from "../../src/modules/exploration/expedition-incidental-transport-seam.js";
import { createCorrelationId, createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";
import type { IssuedIncidentalMenu } from "../../src/platform/exploration/postgres-incidental-menu-snapshots.js";
import { renderExpeditionV4IncidentalPanel } from "../../src/modules/exploration/expedition-v4-incidental-panel.js";

function fixture() {
  const playerId = createPlayerId();
  const encounterId = randomUUID();
  const view = renderExpeditionV4IncidentalPanel({
    source: "INCIDENTAL", encounterStatus: "ENGAGED",
    encounterId, encounterRevision: 2n, speciesName: "Zigzagoon",
    level: 5, canBattle: true, canIgnore: true, ignoreMinutes: 10,
    balls: [{ kind: "POKE", quantity: 2, captureAuthorized: true }],
    combiningCount: 0,
  });
  if (!view.ok) throw new Error("Could not create test incidental menu");
  const menu: IssuedIncidentalMenu = {
    menuId: randomUUID(), outcomeId: randomUUID(),
    menu: view.value, ballItemIds: { POKE: randomUUID() },
  };
  const ref = {
    provider: "baileys", chatRef: "group@g.us",
    externalMessageId: "provider-message-123",
  };
  const snapshots = { issue: vi.fn(async () => ok(menu)) };
  const sender = { send: vi.fn(async () => ok(ref)) };
  const bindings = {
    bindDelivered: vi.fn(async () => ok(undefined)),
    resolveReply: vi.fn(async () => ok(menu)),
  };
  const captureResult = {
    captureAttemptId: randomUUID(), encounterId,
    battleId: null, status: "FAILED" as const,
    probabilityBasisPoints: 2000, rollBasisPoints: 8500,
    pokemonInstanceId: null, placement: null, replayed: false, events: [],
  };
  const dispatcher = { dispatchCaptureReply: vi.fn(async () => ok(captureResult)) };
  const seam = new ExpeditionIncidentalTransportSeam(snapshots, bindings, sender, dispatcher);
  const outbound = {
    playerId, outcomeId: menu.outcomeId, canBattle: true, canIgnore: true,
    combiningCount: 0, provider: ref.provider, chatRef: ref.chatRef,
  };
  const inbound = {
    playerId, provider: ref.provider, chatRef: ref.chatRef,
    quotedExternalMessageId: ref.externalMessageId, rawChoice: "2",
    inboxIdempotencyKey: "inbox:verified-original-id",
    correlationId: createCorrelationId(), causationId: null,
  };
  return {
    menu, ref, snapshots, sender, bindings, dispatcher, seam, outbound, inbound,
    captureResult,
  };
}

describe("Incidental transport seam, shadow-only", () => {
  it("sends EXACT server menu then binds provider receipt for authenticated trainer", async () => {
    const f = fixture();
    expect(await f.seam.present(f.outbound)).toEqual(ok({
      menuId: f.menu.menuId, message: f.ref, text: f.menu.menu.text,
    }));
    expect(f.snapshots.issue).toHaveBeenCalledWith({
      playerId: f.outbound.playerId, outcomeId: f.outbound.outcomeId,
      canBattle: true, canIgnore: true, combiningCount: 0,
    });
    expect(f.sender.send).toHaveBeenCalledExactlyOnceWith({
      provider: f.ref.provider, chatRef: f.ref.chatRef,
      menuId: f.menu.menuId, text: f.menu.menu.text,
    });
    expect(f.bindings.bindDelivered).toHaveBeenCalledExactlyOnceWith({
      playerId: f.outbound.playerId, menuId: f.menu.menuId, message: f.ref,
    });
  });

  it("does not send if issuance failed, and never binds a mismatched provider/chat receipt", async () => {
    const f = fixture();
    f.snapshots.issue.mockResolvedValueOnce(err(appError("FLOW_BLOCKED", "Not eligible")));
    expect((await f.seam.present(f.outbound)).ok).toBe(false);
    expect(f.sender.send).not.toHaveBeenCalled();
    f.sender.send.mockResolvedValueOnce(ok({ ...f.ref, chatRef: "foreign@g.us" }));
    expect((await f.seam.present(f.outbound)).ok).toBe(false);
    expect(f.bindings.bindDelivered).not.toHaveBeenCalled();
  });

  it("propagates uncertain send and binding failures without saying delivery succeeded", async () => {
    const f = fixture();
    f.sender.send.mockResolvedValueOnce(err(appError("FLOW_BLOCKED", "Provider failed")));
    expect((await f.seam.present(f.outbound)).ok).toBe(false);
    expect(f.bindings.bindDelivered).not.toHaveBeenCalled();
    f.bindings.bindDelivered.mockResolvedValueOnce(err(appError("FLOW_BLOCKED", "DB unavailable")));
    expect((await f.seam.present(f.outbound)).ok).toBe(false);
    expect(f.sender.send).toHaveBeenCalledTimes(2);
  });

  it("accepts only 2/3/4 and retains the original inbox idempotency key and quoted chat", async () => {
    const f = fixture();
    expect(await f.seam.captureQuotedReply(f.inbound)).toEqual(ok(f.captureResult));
    expect(f.dispatcher.dispatchCaptureReply).toHaveBeenCalledExactlyOnceWith({
      playerId: f.inbound.playerId,
      repliedTo: f.ref, resolver: f.bindings,
      rawChoice: "2", inboxIdempotencyKey: "inbox:verified-original-id",
      correlationId: f.inbound.correlationId, causationId: null,
    });
    await f.seam.captureQuotedReply(f.inbound);
    expect(f.dispatcher.dispatchCaptureReply.mock.calls).toHaveLength(2);
    expect(f.dispatcher.dispatchCaptureReply.mock.calls[0]).toEqual(
      f.dispatcher.dispatchCaptureReply.mock.calls[1],
    );
  });

  it("rejects unsupported options and forged provider context before resolving menus", async () => {
    const f = fixture();
    for (const input of [
      { ...f.inbound, rawChoice: "1" },
      { ...f.inbound, rawChoice: "0" },
      { ...f.inbound, rawChoice: "Poké Ball" },
      { ...f.inbound, rawChoice: "2 3" },
      { ...f.inbound, inboxIdempotencyKey: " " },
      { ...f.inbound, provider: "BAILEYS<script>" },
      { ...f.inbound, quotedExternalMessageId: "invalid\nreply" },
    ]) expect((await f.seam.captureQuotedReply(input)).ok).toBe(false);
    expect(f.dispatcher.dispatchCaptureReply).not.toHaveBeenCalled();
  });
});
