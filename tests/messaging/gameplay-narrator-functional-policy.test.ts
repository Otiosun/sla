import { describe, expect, it, vi } from "vitest";
import { createPveBattleStartWhatsAppRoute } from "../../src/modules/battle/pve-battle-start.js";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import { capabilitiesForWorldGroupSetup } from "../../src/modules/community/world-group-setup.js";
import { createSpawnWhatsAppRoute } from "../../src/modules/encounter/spawn-whatsapp.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const PLAYER = createPlayerId();
const ENCOUNTER = "00000000-0000-4000-8000-000000007201";
const BATTLE = "00000000-0000-4000-8000-000000007202";
const NARRATOR = "5511888888888@s.whatsapp.net";
const PLAYER_REF = "5511999999999@s.whatsapp.net";

function context(text: string, senderRef: string): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000007203",
    correlationId: "00000000-0000-4000-8000-000000007204",
    causationId: "00000000-0000-4000-8000-000000007203",
    idempotencyKey: "narrator-proof:" + text,
    message: {
      provider: "baileys",
      externalMessageId: "narrator-test",
      senderRef,
      chatRef: "120363900072@g.us",
      occurredAt: "2026-10-23T12:00:00.000Z",
      text,
      mentions: text.includes("@alvo") ? [PLAYER_REF] : [],
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function setup() {
  const resolvePlayer = vi.fn(async () => ok({ playerId: PLAYER, state: "COMPLETE" }));
  const createOrReplay = vi.fn(async () =>
    ok({
      encounterId: ENCOUNTER,
      revision: 0n,
      contentReleaseId: "00000000-0000-4000-8000-000000007205",
      snapshot: { speciesId: "00000000-0000-4000-8000-000000007206", level: 8 },
    }),
  );
  const startCanonical = vi.fn(async () => ok({ start: { battleId: BATTLE } }));
  const definitions = [
    createSpawnWhatsAppRoute({
      players: { resolvePlayer },
      encounters: { createOrReplay },
      speciesDisplayName: async () => "Pidgey",
      context: {
        resolve: async () => ({
          kind: "READY" as const,
          areaDisplayName: "Campos de Yun",
          participantCount: 1,
        }),
      },
    } as never),
    createPveBattleStartWhatsAppRoute({
      players: { resolvePlayer },
      encounters: {
        activeForPlayer: async () =>
          ok({ encounterId: ENCOUNTER, playerId: PLAYER, status: "CREATED", revision: 0n }),
      },
      start: { startCanonical },
    } as never),
  ];
  const gate = new RuntimeCommandPolicyGate({
    community: {
      resolveChat: async () => ({
        known: true as const,
        groupId: "00000000-0000-4000-8000-000000007207",
        role: "GAME" as const,
        capabilities: capabilitiesForWorldGroupSetup("GAME", []),
      }),
    },
    players: { resolvePlayer },
    access: {
      load: async () => ({
        playerId: PLAYER,
        status: "ACTIVE" as const,
        approvedReviewId: "00000000-0000-4000-8000-000000007208",
        revision: 1,
      }),
    },
    admins: {
      capabilitiesFor: async ({ externalId }) =>
        externalId === NARRATOR ? ["encounter.support"] : [],
    },
  });
  return { router: new MessageRouter(definitions, gate), createOrReplay, startCanonical };
}

describe("narrator commands with real handlers under GAME policy", () => {
  it("admits an authorized narrator to create and start a wild encounter", async () => {
    const current = setup();
    const spawned = await current.router.dispatch(context("/spawn @alvo", NARRATOR));
    expect(spawned).toMatchObject({
      ok: true,
      value: { resultRefType: "ENCOUNTER", resultRefId: ENCOUNTER },
    });
    expect(current.createOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: PLAYER, spawnQuantity: 1 }),
    );
    const started = await current.router.dispatch(context("/iniciarbatalha @alvo", NARRATOR));
    expect(started).toMatchObject({
      ok: true,
      value: { resultRefType: "BATTLE", resultRefId: BATTLE },
    });
    expect(current.startCanonical).toHaveBeenCalledWith({
      playerId: PLAYER,
      encounterId: ENCOUNTER,
      status: "CREATED",
      expectedRevision: 0n,
    });
  });

  it("blocks ordinary players from both mutations before handlers execute", async () => {
    const current = setup();
    for (const command of ["/spawn @alvo", "/iniciarbatalha @alvo"]) {
      expect(await current.router.dispatch(context(command, PLAYER_REF))).toMatchObject({
        ok: false,
        error: {
          code: "PLAYER_INELIGIBLE",
          details: { userMessage: expect.stringContaining("narradores autorizados") },
        },
      });
    }
    expect(current.createOrReplay).not.toHaveBeenCalled();
    expect(current.startCanonical).not.toHaveBeenCalled();
  });
});
