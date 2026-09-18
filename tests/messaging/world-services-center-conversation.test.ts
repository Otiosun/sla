import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type { WorldServiceSessionRecord } from "../../src/modules/world-services/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000003001";
const SESSION_ID = "00000000-0000-4000-8000-000000003002";
const CHAT_REF = "120363000000003001@g.us";

function context(
  text: string,
  replyToExternalMessageId: string | null,
  suffix: string,
): MessageHandlerContext {
  const message: IncomingMessage = {
    provider: "baileys",
    externalMessageId: `center-${suffix}`,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T10:40:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId,
  };
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000031${suffix}`,
    correlationId: `00000000-0000-4000-8000-0000000032${suffix}`,
    causationId: `00000000-0000-4000-8000-0000000031${suffix}`,
    idempotencyKey: `inbox:baileys:center-${suffix}`,
    message,
  };
}

function centerSession(
  expectedReplyOutboxIdempotencyKey: string | null = null,
  expectedReplyExternalMessageId: string | null = null,
  revision = 4n,
): WorldServiceSessionRecord {
  return {
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: "POKEMON_CENTER",
    state: "OPEN",
    sceneProofId: "00000000-0000-4000-8000-000000003003",
    expectedReplyOutboxIdempotencyKey,
    expectedReplyExternalMessageId,
    revision,
    createdAt: new Date("2026-09-07T10:30:00.000Z"),
    updatedAt: new Date("2026-09-07T10:35:00.000Z"),
    closedAt: null,
  };
}

function playerResolver() {
  return {
    resolvePlayer: vi.fn(async () =>
      ok({ playerId: PLAYER_ID, state: "COMPLETE" as const, created: false }),
    ),
  };
}

function worldLocation() {
  return {
    playerId: PLAYER_ID,
    contentReleaseId: "00000000-0000-4000-8000-000000003004",
    areaId: AREA_ID,
    areaSlug: "vila-dos-arrozais",
    areaDisplayName: "Vila dos Arrozais",
    regionId: "00000000-0000-4000-8000-000000003005",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    facilities: ["POKEMART", "POKEMON_CENTER"],
    revision: 0n,
    enteredAt: new Date("2026-09-07T10:00:00.000Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [],
  } as const;
}

function exactReplyVerifier(expectedExternalMessageId: string) {
  return {
    isExpectedReply: vi.fn(
      async (input: { replyToExternalMessageId: string }) =>
        input.replyToExternalMessageId === expectedExternalMessageId,
    ),
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

function resolverFor(promptId: string) {
  const current = centerSession("inbox:x:world-service:center:conversation", promptId, 5n);
  return new WorldServiceConversationResolver({
    community: {
      resolveChat: async () => ({
        known: true,
        groupId: "00000000-0000-4000-8000-000000003006",
        role: "GAME" as const,
        capabilities: ["world" as const],
      }),
    },
    players: playerResolver(),
    world: { getLocation: async () => ok(worldLocation()) },
    sessions: {
      loadActiveSession: async () => ok(current),
      recordSceneProof: vi.fn(),
    },
    replyIntent: exactReplyVerifier(promptId),
  });
}

describe("Pokémon Center conversation", () => {
  it("renders the full Center identity and Hana on entry", async () => {
    const current = centerSession(null, null, 1n);
    const routes = createWorldServiceWhatsAppRoutes({
      players: playerResolver(),
      world: { getLocation: vi.fn(async () => ok(worldLocation())) },
      sessions: {
        openVisit: vi.fn(async () => ok(current)),
        loadActiveSession: vi.fn(async () => ok(current)),
        closeVisit: vi.fn(),
      },
    });

    const result = await routeByCommand(routes, "centropokemon").handler.handle(
      context("/centropokemon", null, "01"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.outgoing[0]?.payload.text;
    expect(text).toContain("𝗖𝗘𝗡𝗧𝗥𝗢 𝗣𝗢𝗞É𝗠𝗢𝗡");
    expect(text).toContain("𝗘𝗡𝗙𝗘𝗥𝗠𝗘𝗜𝗥𝗔 𝗛𝗔𝗡𝗔");
    expect(text).toContain("/curar");
    expect(text).toContain("/pc");
    expect(text).toContain("/conversar");
  });

  it("opens Hana/employee selection only during an active Center visit", async () => {
    const current = centerSession(null, null, 4n);
    const routes = createWorldServiceWhatsAppRoutes({
      players: playerResolver(),
      world: { getLocation: vi.fn(async () => ok(worldLocation())) },
      sessions: {
        openVisit: vi.fn(),
        loadActiveSession: vi.fn(async () => ok(current)),
        closeVisit: vi.fn(),
      },
    });

    const result = await routeByCommand(routes, "conversar").handler.handle(
      context("/conversar", null, "02"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("Enfermeira Hana");
    expect(result.value.outgoing[0]?.payload.text).toContain("Funcionário do Centro");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:conversation");
    expect(result.value.outgoing[0]?.payload.worldServicePrompt).toEqual({
      playerId: PLAYER_ID,
      expectedRevision: "4",
    });
  });

  it("routes exact reply 1 to Hana's Arrozais team-care conversation", async () => {
    const promptId = "WA-CENTER-CONVERSATION-HANA";
    const resolver = resolverFor(promptId);

    const result = await resolver.resolve(context("1", promptId, "03"));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("Enfermeira Hana");
    expect(result.value.outgoing[0]?.payload.text).toContain("Vila dos Arrozais");
    expect(result.value.outgoing[0]?.payload.text).toContain("cuidar da própria equipe");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:conversation:hana");
  });

  it("routes exact reply 2 to the employee explanation of six-Pokémon teams and boxes", async () => {
    const promptId = "WA-CENTER-CONVERSATION-EMPLOYEE";
    const resolver = resolverFor(promptId);

    const result = await resolver.resolve(context("2", promptId, "04"));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) return;
    expect(result.value.outgoing[0]?.payload.text).toContain("Funcionário do Centro");
    expect(result.value.outgoing[0]?.payload.text).toContain("seis Pokémon");
    expect(result.value.outgoing[0]?.payload.text).toContain("caixas do PC");
    expect(result.value.outgoing[0]?.idempotencyKey).toContain(":center:conversation:employee");
  });
});
