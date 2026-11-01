import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import type { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import {
  createExpeditionV4ReadOnlyRoutes,
  createExpeditionV4StagingPreparationRoutes,
  type ExpeditionV4ReadOnlyDeps,
} from "../../src/modules/exploration/expedition-v4-readonly-whatsapp.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldLocationView } from "../../src/modules/world/contracts.js";
import type { ExpeditionSnapshot } from "../../src/modules/exploration/expedition-state.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const currentArea = randomUUID();
const location: WorldLocationView = {
  playerId,
  contentReleaseId: randomUUID(),
  areaId: currentArea,
  areaSlug: "campos-de-yun",
  areaDisplayName: "Campos de Yun",
  regionId: randomUUID(),
  regionSlug: "zhoulia",
  regionDisplayName: "Zhoulia",
  safePoint: true,
  revision: 1n,
  enteredAt: new Date("2026-10-31T15:00:00Z"),
  requiresRelocation: false,
  relocationAreaId: null,
  connections: [],
};
const preparing: ExpeditionSnapshot = {
  expeditionId: randomUUID(),
  playerId,
  areaId: currentArea,
  phase: "PREPARING",
  period: "NIGHT",
  elapsedMinutes: 0,
  consumedWeekKey: null,
  endReason: null,
  revision: 0n,
};

function context(text = "/explorar status"): MessageHandlerContext {
  return {
    inboxMessageId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    idempotencyKey: "inbox:baileys:read-only-1",
    message: {
      provider: "baileys",
      externalMessageId: "read-only-1",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363123456789@g.us",
      occurredAt: "2026-10-31T15:30:00.000Z",
      text,
      replyToExternalMessageId: null,
      mediaRefs: [],
    },
  };
}

function setup() {
  const resolvePlayer = vi.fn(async () =>
    ok({ playerId, state: "COMPLETE" as const, created: false }),
  );
  const getLocation = vi.fn(async () => ok(location));
  const read = vi.fn(async () => ({
    expedition: preparing as ExpeditionSnapshot | null,
    usedThisWeek: 1,
  }));
  const admits = vi.fn(async () => true);
  const deps: ExpeditionV4ReadOnlyDeps = {
    players: { resolvePlayer },
    world: { getLocation },
    facts: { read },
    group: { admits },
    clock: new ManualClock(new Date("2026-10-31T15:30:00.000Z")),
    timeZone: "America/Recife",
  };
  const route = createExpeditionV4ReadOnlyRoutes(deps)[0]!;
  return { route, deps, resolvePlayer, getLocation, read, admits };
}

describe("V4 exploration WhatsApp READ-ONLY staging admission and output", () => {
  it("renders saved PREPARING and real quota privately; no action or public group reply", async () => {
    const f = setup();
    const result = await f.route.handler.handle(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing).toHaveLength(1);
    const outgoing = result.value.outgoing[0]!;
    expect(outgoing.destinationRef).toBe("5579999999999@s.whatsapp.net");
    expect(outgoing.messageType).toBe("TEXT");
    const text = String(outgoing.payload.text);
    expect(text).toContain("Campos de Yun");
    expect(text).toContain("Preparação registrada");
    expect(text).toContain("Cotas restantes:* 2/3");
    expect(text).toContain("Cota ainda não consumida");
    expect(text).toContain("Nenhuma ação, cota, item ou encontro foi alterado");
    expect(text).not.toContain("[Ler mais]");
    expect(text).not.toContain(preparing.expeditionId);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(playerId, "2026-10-26");
    expect(f.admits).toHaveBeenCalledExactlyOnceWith({
      provider: "baileys",
      chatRef: "120363123456789@g.us",
      playerId,
    });
  });

  it("does not interpret a mutating /explorar subcommand or call ANY gameplay reader", async () => {
    const f = setup();
    const result = await f.route.handler.handle(context("/explorar buscar"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.outgoing[0]?.payload.text)).toContain("Nenhuma ação será executada");
    expect(f.resolvePlayer).not.toHaveBeenCalled();
    expect(f.getLocation).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("rejects pending registration and unauthorized groups before World/SQL", async () => {
    const f = setup();
    f.resolvePlayer.mockResolvedValueOnce(ok({ playerId, state: "NEW" as never, created: false }));
    expect((await f.route.handler.handle(context())).ok).toBe(false);
    expect(f.admits).not.toHaveBeenCalled();
    f.admits.mockResolvedValueOnce(false);
    expect((await f.route.handler.handle(context())).ok).toBe(false);
    expect(f.getLocation).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it("denies wrong location or incoherent quota/clock; no fabricated encounters", async () => {
    const f = setup();
    f.read.mockResolvedValueOnce({
      expedition: { ...preparing, playerId, areaId: randomUUID() },
      usedThisWeek: 0,
    });
    expect((await f.route.handler.handle(context())).ok).toBe(false);
    f.read.mockResolvedValueOnce({
      expedition: { ...preparing, elapsedMinutes: 30 },
      usedThisWeek: 0,
    });
    expect((await f.route.handler.handle(context())).ok).toBe(false);
    f.read.mockResolvedValueOnce({ expedition: null, usedThisWeek: 4 });
    expect((await f.route.handler.handle(context())).ok).toBe(false);
  });

  it("reports NONE without offering an unusable numeric menu", async () => {
    const f = setup();
    f.read.mockResolvedValueOnce({ expedition: null, usedThisWeek: 3 });
    const result = await f.route.handler.handle(context("/explorar retomar"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const message = String(result.value.outgoing[0]?.payload.text);
    expect(message).toContain("Nenhuma expedição em andamento");
    expect(message).toContain("Cotas restantes:* 0/3");
    expect(message).not.toContain("1. ☀️");
  });

  it("preserves router policy and fails closed without the policy gate", async () => {
    const f = setup();
    expect(f.route.command).toBe("explorar");
    expect(f.route.policy).toMatchObject({
      requiredGroupCapabilities: ["world", "player.basic"],
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    });
    const router = new MessageRouter([f.route]);
    expect((await router.dispatch(context())).ok).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    const allowed = new MessageRouter([f.route], { authorize: async () => ok(undefined) });
    expect((await allowed.dispatch(context())).ok).toBe(true);
  });

  it("rejects unsafe location labels instead of leaking editorial markers", async () => {
    const f = setup();
    f.getLocation.mockResolvedValueOnce(
      ok({ ...location, areaDisplayName: "Campo [Ler mais] de Yun" }),
    );
    expect((await f.route.handler.handle(context())).ok).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
  });
});

describe("V4 staging-only day/night preparation with canonical write port", () => {
  function staging() {
    const f = setup();
    f.read.mockResolvedValue({ expedition: null, usedThisWeek: 0 });
    const prepare = vi.fn(async (input: Parameters<PostgresExpeditionRepository["prepare"]>[0]) =>
      ok({
        expedition: { ...preparing, playerId: input.playerId, period: input.period },
        replayed: false,
        changed: true,
        consumedWeeklySlot: false,
      }),
    );
    const changePeriod = vi.fn(
      async (input: Parameters<PostgresExpeditionRepository["changePeriod"]>[0]) =>
        ok({
          expedition: {
            ...preparing,
            playerId: input.playerId,
            period: input.period,
            revision: input.expectedRevision + 1n,
          },
          replayed: false,
          changed: true,
          consumedWeeklySlot: false,
        }),
    );
    const end = vi.fn(async (input: Parameters<PostgresExpeditionRepository["end"]>[0]) =>
      ok({
        expedition: {
          ...preparing,
          playerId: input.playerId,
          phase: "ENDED" as const,
          endReason: input.reason,
          revision: input.expectedRevision + 1n,
        },
        replayed: false,
        changed: true,
        consumedWeeklySlot: false,
      }),
    );
    const route = createExpeditionV4StagingPreparationRoutes({
      ...f.deps,
      preparation: { prepare, changePeriod, end },
    })[0]!;
    return { ...f, prepare, changePeriod, end, route };
  }

  it("presents approved open-state day/night choice before preparing without writes", async () => {
    const f = staging();
    const result = await f.route.handler.handle(context("/explorar"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text);
    expect(text).toContain("Diurno");
    expect(text).toContain("Noturno");
    expect(text).toContain("/explorar 1");
    expect(text).not.toContain("[Ler mais]");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(result.value.outgoing[0]?.destinationRef).toBe("5579999999999@s.whatsapp.net");
  });

  it.each([
    ["/explorar 1", "DAY"],
    ["/explorar 2", "NIGHT"],
    ["/explorar preparar dia", "DAY"],
    ["/explorar preparar noite", "NIGHT"],
  ] as const)(
    "persists %s through the only authorized preparation writer",
    async (command, period) => {
      const f = staging();
      const result = await f.route.handler.handle(context(command));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
        playerId,
        period,
        idempotencyKey: "inbox:baileys:read-only-1",
      });
      const text = String(result.value.outgoing[0]?.payload.text);
      expect(text).toContain("Cota ainda não consumida");
      expect(text).toContain(period === "DAY" ? "06:00" : "18:00");
      expect(text).toContain("buscas, captura e viagem continuam desativadas");
      expect(result.value.outgoing[0]?.destinationRef).toBe("5579999999999@s.whatsapp.net");
    },
  );

  it("does not accept bare 1/2, free-form or action words as preparation", async () => {
    const f = staging();
    for (const command of ["1", "2", "/explorar buscar", "/explorar viajar", "/explorar 1 2"]) {
      const result = await f.route.handler.handle(context(command));
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(String(result.value.outgoing[0]?.payload.text)).toContain(
          "Nenhuma ação será executada",
        );
    }
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.resolvePlayer).not.toHaveBeenCalled();
  });

  it("keeps the existing read-only factory unable to inherit a writer", async () => {
    const f = staging();
    const readonly = createExpeditionV4ReadOnlyRoutes({
      ...f.deps,
      preparation: { prepare: f.prepare, changePeriod: f.changePeriod, end: f.end },
    })[0]!;
    const result = await readonly.handler.handle(context("/explorar 1"));
    expect(result.ok).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["/explorar periodo dia", "DAY"],
    ["/explorar período noite", "NIGHT"],
  ] as const)(
    "changes PREPARING period via revision-guarded receipt for %s",
    async (command, period) => {
      const f = staging();
      f.read.mockResolvedValueOnce({ expedition: preparing, usedThisWeek: 0 });
      const result = await f.route.handler.handle(context(command));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(f.changePeriod).toHaveBeenCalledExactlyOnceWith({
        playerId,
        expeditionId: preparing.expeditionId,
        expectedRevision: preparing.revision,
        period,
        idempotencyKey: "inbox:baileys:read-only-1",
      });
      expect(String(result.value.outgoing[0]?.payload.text)).toContain("Nenhuma cota consumida");
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.end).not.toHaveBeenCalled();
    },
  );

  it("cancels only PREPARING and sends the private no-cost acknowledgement", async () => {
    const f = staging();
    f.read.mockResolvedValueOnce({ expedition: preparing, usedThisWeek: 1 });
    const result = await f.route.handler.handle(context("/explorar cancelar"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(f.end).toHaveBeenCalledExactlyOnceWith({
      playerId,
      expeditionId: preparing.expeditionId,
      expectedRevision: preparing.revision,
      reason: "CANCELLED",
      idempotencyKey: "inbox:baileys:read-only-1",
    });
    expect(result.value.outgoing).toHaveLength(1);
    expect(result.value.outgoing[0]?.destinationRef).toBe("5579999999999@s.whatsapp.net");
    expect(String(result.value.outgoing[0]?.payload.text)).toContain("Preparação cancelada");
    expect(f.changePeriod).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("advertises only available free decisions on PREPARING status in staging", async () => {
    const f = staging();
    f.read.mockResolvedValueOnce({ expedition: preparing, usedThisWeek: 0 });
    const result = await f.route.handler.handle(context("/explorar status"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = String(result.value.outgoing[0]?.payload.text);
    expect(text).toContain("/explorar periodo dia");
    expect(text).toContain("/explorar cancelar");
    expect(text).not.toContain("[Ler mais]");
    expect(f.changePeriod).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it("denies edits when no PREPARING state or once the first timed action began", async () => {
    const f = staging();
    for (const expedition of [
      null,
      { ...preparing, phase: "ACTIVE" as const, elapsedMinutes: 30, consumedWeekKey: "2026-10-26" },
    ]) {
      f.read.mockResolvedValueOnce({ expedition, usedThisWeek: 1 });
      expect((await f.route.handler.handle(context("/explorar periodo dia"))).ok).toBe(false);
      f.read.mockResolvedValueOnce({ expedition, usedThisWeek: 1 });
      expect((await f.route.handler.handle(context("/explorar cancelar"))).ok).toBe(false);
    }
    expect(f.changePeriod).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it("fails closed if the repository returns a changed quota or wrong terminal phase", async () => {
    const f = staging();
    f.read.mockResolvedValueOnce({ expedition: preparing, usedThisWeek: 0 });
    f.changePeriod.mockResolvedValueOnce(
      ok({
        expedition: { ...preparing, period: "DAY" as const },
        replayed: false,
        changed: true,
        consumedWeeklySlot: true,
      }),
    );
    expect((await f.route.handler.handle(context("/explorar periodo dia"))).ok).toBe(false);

    f.read.mockResolvedValueOnce({ expedition: preparing, usedThisWeek: 0 });
    f.end.mockResolvedValueOnce(
      ok({
        expedition: { ...preparing, phase: "ENDED" as const, endReason: "VOLUNTARY" as const },
        replayed: false,
        changed: true,
        consumedWeeklySlot: false,
      }),
    );
    expect((await f.route.handler.handle(context("/explorar cancelar"))).ok).toBe(false);
  });

  it("does not offer staging period choices outside the two approved launch areas", async () => {
    const f = staging();
    f.getLocation.mockResolvedValueOnce(
      ok({ ...location, areaSlug: "rota-externa", areaDisplayName: "Rota Externa" }),
    );
    const result = await f.route.handler.handle(context("/explorar"));
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("fails closed on invalid group and mismatching persistent preparation", async () => {
    const f = staging();
    f.admits.mockResolvedValueOnce(false);
    expect((await f.route.handler.handle(context("/explorar 2"))).ok).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();

    f.prepare.mockResolvedValueOnce(
      ok({
        expedition: { ...preparing, playerId, areaId: randomUUID() },
        replayed: false,
        changed: true,
        consumedWeeklySlot: false,
      }),
    );
    expect((await f.route.handler.handle(context("/explorar 2"))).ok).toBe(false);
  });
});
