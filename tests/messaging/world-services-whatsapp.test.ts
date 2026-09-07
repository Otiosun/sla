import { describe, expect, it, vi } from "vitest";
import type {
  IncomingMessage,
  MessageHandlerContext,
} from "../../src/modules/messaging/contracts.js";
import { createWorldServiceWhatsAppRoutes } from "../../src/modules/world-services/whatsapp-handlers.js";
import { WorldServiceConversationResolver } from "../../src/modules/world-services/conversation-resolver.js";
import type {
  SceneProofRecord,
  WorldServiceKind,
  WorldServiceSessionRecord,
} from "../../src/modules/world-services/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = createPlayerId();
const AREA_ID = "00000000-0000-4000-8000-000000000501";
const CHAT_REF = "120363000000000501@g.us";
const CURRENT_PROMPT = "WA-WORLD-SERVICE-CURRENT";
const EXPECTED_OUTBOX_KEY = "world-service:prompt:current";

function message(
  text: string,
  replyToExternalMessageId: string | null = null,
  externalMessageId = "world-service-message",
): IncomingMessage {
  return {
    provider: "baileys",
    externalMessageId,
    senderRef: "5511999999999@s.whatsapp.net",
    chatRef: CHAT_REF,
    occurredAt: "2026-09-07T05:40:00.000Z",
    text,
    mediaRefs: [],
    replyToExternalMessageId,
  };
}

function context(
  text: string,
  replyToExternalMessageId: string | null = null,
  suffix = "1",
): MessageHandlerContext {
  return {
    inboxMessageId: `00000000-0000-4000-8000-0000000006${suffix.padStart(2, "0")}`,
    correlationId: `00000000-0000-4000-8000-0000000007${suffix.padStart(2, "0")}`,
    causationId: `00000000-0000-4000-8000-0000000006${suffix.padStart(2, "0")}`,
    idempotencyKey: `inbox:baileys:world-service-${suffix}`,
    message: message(text, replyToExternalMessageId, `world-service-${suffix}`),
  };
}

function activeSession(
  kind: WorldServiceKind = "POKEMART",
  overrides: Partial<WorldServiceSessionRecord> = {},
): WorldServiceSessionRecord {
  return {
    sessionId: "00000000-0000-4000-8000-000000000801",
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    serviceKind: kind,
    state: "OPEN",
    sceneProofId: kind === "PC" ? null : "00000000-0000-4000-8000-000000000802",
    expectedReplyOutboxIdempotencyKey: null,
    expectedReplyExternalMessageId: null,
    revision: 0n,
    createdAt: new Date("2026-09-07T05:30:00.000Z"),
    updatedAt: new Date("2026-09-07T05:30:00.000Z"),
    closedAt: null,
    ...overrides,
  };
}

function worldLocation() {
  return {
    playerId: PLAYER_ID,
    contentReleaseId: "00000000-0000-4000-8000-000000000901",
    areaId: AREA_ID,
    areaSlug: "zhoulia-central",
    areaDisplayName: "Centro de Zhoulia",
    regionId: "00000000-0000-4000-8000-000000000902",
    regionSlug: "zhoulia",
    regionDisplayName: "Zhoulia",
    safePoint: true,
    revision: 0n,
    enteredAt: new Date("2026-09-07T05:00:00.000Z"),
    requiresRelocation: false,
    relocationAreaId: null,
    connections: [],
  } as const;
}

function routeFixture() {
  let proofAvailable = false;
  let current: WorldServiceSessionRecord | null = null;

  const sessions = {
    openVisit: vi.fn(async (input: { serviceKind: WorldServiceKind; areaId: string }) => {
      if (input.serviceKind !== "PC" && !proofAvailable) {
        return err(appError("ACTION_INVALID", "scene proof required"));
      }
      current = activeSession(input.serviceKind);
      return ok(current);
    }),
    loadActiveSession: vi.fn(async () => ok(current)),
    closeVisit: vi.fn(async (input: { expectedRevision: bigint }) => {
      if (current === null) return err(appError("NOT_FOUND", "visit not active"));
      const closed: WorldServiceSessionRecord = {
        ...current,
        state: "CLOSED",
        revision: input.expectedRevision + 1n,
        updatedAt: new Date("2026-09-07T05:45:00.000Z"),
        closedAt: new Date("2026-09-07T05:45:00.000Z"),
      };
      current = null;
      return ok(closed);
    }),
  };

  const dependencies = {
    players: {
      resolvePlayer: vi.fn(async () => ok({ playerId: PLAYER_ID, state: "COMPLETE" as const })),
    },
    world: {
      getLocation: vi.fn(async () => ok(worldLocation())),
    },
    sessions,
  };

  return {
    dependencies,
    sessions,
    setProofAvailable(value: boolean) {
      proofAvailable = value;
    },
    setCurrent(session: WorldServiceSessionRecord | null) {
      current = session;
    },
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

function resolverFixture(session: WorldServiceSessionRecord | null) {
  const proof: SceneProofRecord = {
    proofId: "00000000-0000-4000-8000-000000000a01",
    playerId: PLAYER_ID,
    areaId: AREA_ID,
    sourceInboxMessageId: "00000000-0000-4000-8000-000000000601",
    lineCount: 4,
    createdAt: new Date("2026-09-07T05:40:00.000Z"),
    consumedAt: null,
  };
  const sessions = {
    loadActiveSession: vi.fn(async () => ok(session)),
    recordSceneProof: vi.fn(async () => ok(proof)),
  };
  const replyIntent = {
    isExpectedReply: vi.fn(
      async (input: { replyToExternalMessageId: string }) =>
        input.replyToExternalMessageId === CURRENT_PROMPT,
    ),
  };
  const resolver = new WorldServiceConversationResolver({
    community: {
      resolveChat: async () => ({
        known: true,
        groupId: "00000000-0000-4000-8000-000000000b01",
        role: "GAME" as const,
        capabilities: ["world" as const, "player.basic" as const],
      }),
    },
    players: {
      resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "COMPLETE" as const }),
    },
    world: {
      getLocation: async () => ok(worldLocation()),
    },
    sessions,
    replyIntent,
  });
  return { resolver, sessions, replyIntent };
}

describe("World Services WhatsApp", () => {
  it("requires a current-area scene proof for Mart entry and opens after proof exists", async () => {
    const fixture = routeFixture();
    const routes = createWorldServiceWhatsAppRoutes(fixture.dependencies);
    const pokemart = routeByCommand(routes, "pokemart");

    const rejected = await pokemart.handler.handle(context("/pokemart", null, "11"));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("ACTION_INVALID");

    fixture.setProofAvailable(true);
    const opened = await pokemart.handler.handle(context("/pokemart", null, "12"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(fixture.sessions.openVisit).toHaveBeenLastCalledWith({
      playerId: PLAYER_ID,
      areaId: AREA_ID,
      serviceKind: "POKEMART",
    });
    expect(opened.value.outgoing[0]?.payload.text).toContain("POKÉ MART");
  });

  it("opens PC without consuming a scene proof and closes the active service with /sair", async () => {
    const fixture = routeFixture();
    const routes = createWorldServiceWhatsAppRoutes(fixture.dependencies);

    const opened = await routeByCommand(routes, "pc").handler.handle(context("/pc", null, "21"));
    expect(opened.ok).toBe(true);
    expect(fixture.sessions.openVisit).toHaveBeenLastCalledWith({
      playerId: PLAYER_ID,
      areaId: AREA_ID,
      serviceKind: "PC",
    });

    fixture.setCurrent(activeSession("PC", { revision: 4n }));
    const closed = await routeByCommand(routes, "sair").handler.handle(
      context("/sair", null, "22"),
    );
    expect(closed.ok).toBe(true);
    expect(fixture.sessions.closeVisit).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      expectedRevision: 4n,
    });
  });

  it("records a standalone four-line scene proof in the player's current area without speaking", async () => {
    const fixture = resolverFixture(null);
    const incoming = message("linha 1\nlinha 2\nlinha 3\nlinha 4", null, "scene-proof");
    expect(await fixture.resolver.admits(incoming)).toBe(true);

    const resolved = await fixture.resolver.resolve(
      context("linha 1\nlinha 2\nlinha 3\nlinha 4", null, "31"),
    );

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        resultRefType: "WORLD_SERVICE_SCENE_PROOF",
        outgoing: [],
      },
    });
    expect(fixture.sessions.recordSceneProof).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      areaId: AREA_ID,
      sourceInboxMessageId: "00000000-0000-4000-8000-000000000631",
      text: "linha 1\nlinha 2\nlinha 3\nlinha 4",
    });
  });

  it("keeps non-replies, human replies and stale prompt replies silent", async () => {
    const session = activeSession("POKEMART", {
      expectedReplyOutboxIdempotencyKey: EXPECTED_OUTBOX_KEY,
      expectedReplyExternalMessageId: CURRENT_PROMPT,
      revision: 2n,
    });
    const fixture = resolverFixture(session);

    for (const incoming of [
      message("1", null, "plain-number"),
      message("1", "human-message", "human-reply"),
      message("1", "WA-WORLD-SERVICE-STALE", "stale-reply"),
    ]) {
      expect(await fixture.resolver.admits(incoming)).toBe(false);
    }

    expect(await fixture.resolver.resolve(context("1", null, "41"))).toEqual({
      ok: true,
      value: null,
    });
    expect(await fixture.resolver.resolve(context("1", "human-message", "42"))).toEqual({
      ok: true,
      value: null,
    });
    expect(await fixture.resolver.resolve(context("1", "WA-WORLD-SERVICE-STALE", "43"))).toEqual({
      ok: true,
      value: null,
    });
  });

  it("consumes only a reply bound to the exact active service prompt", async () => {
    const session = activeSession("POKEMART", {
      expectedReplyOutboxIdempotencyKey: EXPECTED_OUTBOX_KEY,
      expectedReplyExternalMessageId: CURRENT_PROMPT,
      revision: 2n,
    });
    const fixture = resolverFixture(session);
    const incoming = message("1", CURRENT_PROMPT, "exact-reply");

    expect(await fixture.resolver.admits(incoming)).toBe(true);
    const resolved = await fixture.resolver.resolve(context("1", CURRENT_PROMPT, "51"));

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        resultRefType: "WORLD_SERVICE_REPLY",
        resultRefId: session.sessionId,
        outgoing: [],
      },
    });
    expect(fixture.replyIntent.isExpectedReply).toHaveBeenCalledWith({
      provider: "baileys",
      chatRef: CHAT_REF,
      replyToExternalMessageId: CURRENT_PROMPT,
      expectedOutboxIdempotencyKey: EXPECTED_OUTBOX_KEY,
    });
  });
});
