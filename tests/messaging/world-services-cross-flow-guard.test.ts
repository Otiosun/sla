import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import {
  createOperationalUxRoutes,
  type OperationalUxDependencies,
} from "../../src/modules/messaging/operational-ux-handlers.js";
import type { CommandRouteDefinition } from "../../src/modules/messaging/router.js";
import type {
  WorldServiceKind,
  WorldServiceSessionRecord,
} from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000009001";
const DESTINATION_ID = "00000000-0000-4000-8000-000000009002";
const SESSION_ID = "00000000-0000-4000-8000-000000009003";

function context(text: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000091${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000092${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000091${suffix}`,
    idempotencyKey: `inbox:baileys:cross-flow-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `cross-flow-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000009001@g.us",
      occurredAt: "2026-09-18T03:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function activeSession(serviceKind: WorldServiceKind = "POKEMART"): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind,
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000009004",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 0n,
    createdAt: new Date("2026-09-18T02:55:00.000Z"),
    updatedAt: new Date("2026-09-18T02:55:00.000Z"),
    closedAt: null,
  };
}

function location() {
  return {
    playerId: PLAYER_ID,
    contentReleaseId: "00000000-0000-4000-8000-000000009005",
    areaId: AREA_ID,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "00000000-0000-4000-8000-000000009006",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    facilities: ["POKEMART", "POKEMON_CENTER"] as const,
    revision: 0n,
    enteredAt: new Date("2026-09-18T02:00:00.000Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [
      {
        connectionId: "00000000-0000-4000-8000-000000009007",
        connectionKey: "vila-para-rota",
        destinationAreaId: DESTINATION_ID,
        destinationSlug: "rota-dos-arrozais",
        destinationDisplayName: "Rota dos Arrozais",
        available: true,
        missingUnlockKeys: [],
      },
    ],
  } as const;
}

function routeByCommand(
  routes: readonly CommandRouteDefinition[],
  command: string,
): CommandRouteDefinition {
  const route = routes.find((candidate) => candidate.command === command);
  if (route === undefined) throw new Error(`Missing route ${command}`);
  return route;
}

function playerResolver() {
  return {
    resolvePlayer: vi.fn(async () =>
      ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
    ),
  };
}

describe("World Services cross-flow guard", () => {
  it("blocks /ir while a facility session is active before world travel can mutate location", async () => {
    const travel = vi.fn();
    const routes = createOperationalUxRoutes({
      registration: playerResolver(),
      world: {
        getLocation: vi.fn(async () => ok(location())),
        travel,
      },
      sessions: {
        loadActiveSession: vi.fn(async () => ok(activeSession())),
      },
    } as unknown as OperationalUxDependencies);

    const result = await routeByCommand(routes, "ir").handler.handle(context("/ir 1", "01"));

    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(travel).not.toHaveBeenCalled();
  });

  it("blocks facility entry during battle, encounter, and travel in that priority order", async () => {
    const openVisit = vi.fn();
    const base = {
      players: playerResolver(),
      world: {
        getLocation: vi.fn(async () => ok(location())),
        travelLock: vi.fn(async () => ok(null)),
      },
      sessions: {
        openVisit,
        loadActiveSession: vi.fn(async () => ok(null)),
        closeVisit: vi.fn(),
      },
    };

    const battleRoutes = createWorldServiceWhatsAppRoutes({
      ...base,
      activeBattleId: async () => "00000000-0000-4000-8000-000000009008",
      activeEncounter: async () => ok({ encounterId: "encounter-ignored" } as never),
    });
    const battle = await routeByCommand(battleRoutes, "pokemart").handler.handle(
      context("/pokemart", "02"),
    );
    expect(battle).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    if (!battle.ok) expect(battle.error.message).toMatch(/batalha/i);

    const encounterRoutes = createWorldServiceWhatsAppRoutes({
      ...base,
      activeBattleId: async () => null,
      activeEncounter: async () =>
        ok({ encounterId: "00000000-0000-4000-8000-000000009009" } as never),
    });
    const encounter = await routeByCommand(encounterRoutes, "centropokemon").handler.handle(
      context("/centropokemon", "03"),
    );
    expect(encounter).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    if (!encounter.ok) expect(encounter.error.message).toMatch(/encontro/i);

    const travelRoutes = createWorldServiceWhatsAppRoutes({
      ...base,
      world: {
        ...base.world,
        travelLock: async () =>
          ok({
            destinationAreaId: DESTINATION_ID,
            availableAt: new Date("2026-09-18T03:01:00.000Z"),
          }),
      },
      activeBattleId: async () => null,
      activeEncounter: async () => err(appError("NOT_FOUND", "No active encounter")),
    });
    const travel = await routeByCommand(travelRoutes, "pokemart").handler.handle(
      context("/pokemart", "04"),
    );
    expect(travel).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    if (!travel.ok) expect(travel.error.message).toMatch(/viagem/i);

    expect(openVisit).not.toHaveBeenCalled();
  });

  it("blocks /pescar inside a facility without consuming a fishing attempt", async () => {
    const attempt = vi.fn();
    const routes = createWorldServiceWhatsAppRoutes({
      players: playerResolver(),
      world: {
        getLocation: vi.fn(async () => ok(location())),
        travelLock: vi.fn(async () => ok(null)),
      },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(activeSession("POKEMON_CENTER"))),
        closeVisit: vi.fn(),
      },
      activeBattleId: async () => null,
      activeEncounter: async () => err(appError("NOT_FOUND", "No active encounter")),
      fishing: { attempt },
    });

    const result = await routeByCommand(routes, "pescar").handler.handle(context("/pescar", "05"));

    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("keeps /sair available as the recovery path even if higher-priority state also exists", async () => {
    const session = activeSession("POKEMON_CENTER");
    const closeVisit = vi.fn(async () =>
      ok({
        ...session,
        state: "CLOSED" as const,
        revision: 1n,
        updatedAt: new Date("2026-09-18T03:00:00.000Z"),
        closedAt: new Date("2026-09-18T03:00:00.000Z"),
      }),
    );
    const routes = createWorldServiceWhatsAppRoutes({
      players: playerResolver(),
      world: {
        getLocation: vi.fn(async () => ok(location())),
        travelLock: async () =>
          ok({
            destinationAreaId: DESTINATION_ID,
            availableAt: new Date("2026-09-18T03:01:00.000Z"),
          }),
      },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(session)),
        closeVisit,
      },
      activeBattleId: async () => "00000000-0000-4000-8000-000000009010",
      activeEncounter: async () =>
        ok({ encounterId: "00000000-0000-4000-8000-000000009011" } as never),
    });

    const result = await routeByCommand(routes, "sair").handler.handle(context("/sair", "06"));

    expect(result.ok).toBe(true);
    expect(closeVisit).toHaveBeenCalledWith({ playerId: PLAYER_ID, expectedRevision: 0n });
  });
});
