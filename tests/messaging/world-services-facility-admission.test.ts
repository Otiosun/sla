import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type {
  WorldServiceKind,
  WorldServiceSessionRecord,
} from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000003001";

function context(command: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000031${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000032${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000031${suffix}`,
    idempotencyKey: `inbox:baileys:facility-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `facility-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000003001@g.us",
      occurredAt: "2026-09-08T16:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function location(facilities: readonly ("POKEMART" | "POKEMON_CENTER")[]) {
  return {
    playerId: PLAYER_ID,
    contentReleaseId: "00000000-0000-4000-8000-000000003002",
    areaId: AREA_ID,
    areaSlug: "uat-area",
    areaDisplayName: "UAT Area",
    regionId: "00000000-0000-4000-8000-000000003003",
    regionSlug: "uat-region",
    regionDisplayName: "UAT Region",
    safePoint: true,
    facilities,
    revision: 0n,
    enteredAt: new Date("2026-09-08T15:00:00.000Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [],
  } as const;
}

function openedSession(serviceKind: WorldServiceKind): WorldServiceSessionRecord {
  return {
    sessionId: "00000000-0000-4000-8000-000000003004",
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind,
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000003005",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 0n,
    createdAt: new Date("2026-09-08T16:00:00.000Z"),
    updatedAt: new Date("2026-09-08T16:00:00.000Z"),
    closedAt: null,
  };
}

function fixture(facilities: readonly ("POKEMART" | "POKEMON_CENTER")[]) {
  const openVisit = vi.fn(async (input: { serviceKind: WorldServiceKind }) =>
    ok(openedSession(input.serviceKind)),
  );
  const routes = createWorldServiceWhatsAppRoutes({
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      ),
    },
    world: { getLocation: vi.fn(async () => ok(location(facilities))) },
    sessions: {
      openVisit,
      loadActiveSession: vi.fn(),
      closeVisit: vi.fn(),
    },
  });
  return { routes, openVisit };
}

function routeByCommand(
  routes: ReturnType<typeof createWorldServiceWhatsAppRoutes>,
  command: string,
) {
  const route = routes.find((candidate) => candidate.command === command);
  if (route === undefined) throw new Error(`Missing route ${command}`);
  return route;
}

describe("World Service area facility admission", () => {
  it.each([
    ["pokemart", "POKEMART"],
    ["centropokemon", "POKEMON_CENTER"],
  ] as const)(
    "denies /%s when the current area does not provide %s",
    async (command, _facility) => {
      const current = fixture([]);

      const result = await routeByCommand(current.routes, command).handler.handle(
        context(`/${command}`, command === "pokemart" ? "01" : "02"),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ACTION_INVALID");
        expect(result.error.message).toMatch(/not available/i);
      }
      expect(current.openVisit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["pokemart", "POKEMART"],
    ["centropokemon", "POKEMON_CENTER"],
  ] as const)("allows /%s when the current area provides %s", async (command, facility) => {
    const current = fixture([facility]);

    const result = await routeByCommand(current.routes, command).handler.handle(
      context(`/${command}`, command === "pokemart" ? "03" : "04"),
    );

    expect(result.ok).toBe(true);
    expect(current.openVisit).toHaveBeenCalledTimes(1);
  });
});
