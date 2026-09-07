import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import type { PokemonPcStorageSnapshot } from "../../src/modules/world-services/pc-storage-service.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000002101";
const SESSION_ID = "00000000-0000-4000-8000-000000002102";
const TEAM_POKEMON_ID = createPokemonInstanceId();
const BOX_POKEMON_ID = createPokemonInstanceId();

const STORAGE: PokemonPcStorageSnapshot = {
  playerId: PLAYER_ID,
  team: [
    {
      pokemonInstanceId: TEAM_POKEMON_ID,
      displayName: "Bulbasaur",
      level: 8,
      placementKind: "TEAM",
      boxNo: null,
      slotNo: 1,
    },
  ],
  boxes: [
    {
      boxNo: 1,
      occupied: 1,
      capacity: 30,
      pokemon: [
        {
          pokemonInstanceId: BOX_POKEMON_ID,
          displayName: "Pidgey",
          level: 6,
          placementKind: "BOX",
          boxNo: 1,
          slotNo: 1,
        },
      ],
    },
  ],
};

function context(command: string, suffix: string): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000022${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000023${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000022${suffix}`,
    idempotencyKey: `inbox:baileys:pc-storage-${suffix}`,
    message: {
      provider: "baileys",
      externalMessageId: `pc-storage-${suffix}`,
      senderRef: "5511999999999@s.whatsapp.net",
      chatRef: "120363000000002101@g.us",
      occurredAt: "2026-09-07T12:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function centerSession(revision = 7n): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000002104",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision,
    createdAt: new Date("2026-09-07T11:50:00.000Z"),
    updatedAt: new Date("2026-09-07T11:55:00.000Z"),
    closedAt: null,
  };
}

function routeByCommand(
  definitions: ReturnType<typeof createWorldServiceWhatsAppRoutes>,
  command: string,
) {
  const route = definitions.find((definition) => definition.command === command);
  if (route === undefined) throw new Error(`Missing route ${command}`);
  return route;
}

function fixture() {
  const getStorage = vi.fn(async () => ok(STORAGE));
  const dependencies = {
    players: {
      resolvePlayer: vi.fn(async () =>
        ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
      ),
    },
    world: {
      getLocation: vi.fn(async () =>
        ok({
          playerId: PLAYER_ID,
          contentReleaseId: "00000000-0000-4000-8000-000000002105",
          areaId: AREA_ID,
          areaSlug: "vila-dos-arrozais",
          areaDisplayName: "Vila dos Arrozais",
          regionId: "00000000-0000-4000-8000-000000002106",
          regionSlug: "zhoulia",
          regionDisplayName: "Zhoulia",
          safePoint: true,
          revision: 0n,
          enteredAt: new Date("2026-09-07T11:00:00.000Z"),
          requiresRelocation: false,
          relocationAreaId: null,
          connections: [],
        }),
      ),
    },
    sessions: {
      openVisit: vi.fn(),
      loadActiveSession: vi.fn(async () => ok(centerSession())),
      closeVisit: vi.fn(),
    },
    pcStorage: { getStorage },
  };

  return {
    routes: createWorldServiceWhatsAppRoutes(dependencies),
    getStorage,
  };
}

describe("Pokemon PC WhatsApp storage reads", () => {
  it("renders the canonical team and box occupancy when /pc opens", async () => {
    const current = fixture();

    const result = await routeByCommand(current.routes, "pc").handler.handle(
      context("/pc", "01"),
    );

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗣𝗖 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(result.value.outgoing[0]?.payload.text).toContain("`01 / 06`");
    expect(result.value.outgoing[0]?.payload.text).toContain("Caixa 01");
    expect(result.value.outgoing[0]?.payload.text).toContain("`01 / 30`");
  });

  it("exposes /caixas as a real PC read command backed by the same storage snapshot", async () => {
    const current = fixture();

    const result = await routeByCommand(current.routes, "caixas").handler.handle(
      context("/caixas", "02"),
    );

    expect(current.getStorage).toHaveBeenCalledWith(PLAYER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("𝗖𝗔𝗜𝗫𝗔𝗦");
    expect(result.value.outgoing[0]?.payload.text).toContain("Pidgey");
    expect(result.value.outgoing[0]?.payload.text).toContain("Nv. 06");
  });
});
