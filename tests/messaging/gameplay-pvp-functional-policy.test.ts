import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import { capabilitiesForWorldGroupSetup } from "../../src/modules/community/world-group-setup.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPvpWhatsAppRoutes } from "../../src/modules/pvp/whatsapp-handlers.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const CHALLENGER = createPlayerId();
const TARGET = createPlayerId();
const CHALLENGE = "00000000-0000-4000-8000-000000007101";
const BATTLE = "00000000-0000-4000-8000-000000007102";
const TARGET_REF = "5511777777777@s.whatsapp.net";

function context(text: string, senderRef = "5511999999999@s.whatsapp.net"): MessageHandlerContext {
  return {
    inboxMessageId: "00000000-0000-4000-8000-000000007103",
    correlationId: "00000000-0000-4000-8000-000000007104",
    causationId: "00000000-0000-4000-8000-000000007103",
    idempotencyKey: "pvp-live:" + text,
    message: {
      provider: "baileys",
      externalMessageId: "pvp-functional",
      senderRef,
      chatRef: "120363900071@g.us",
      occurredAt: "2026-10-23T12:00:00.000Z",
      text,
      mentions: text.startsWith("/desafiar ") ? [TARGET_REF] : [],
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function setup(legacy = false) {
  const resolvePlayer = vi.fn(async ({ externalId }: { externalId: string }) =>
    ok({ playerId: externalId === TARGET_REF ? TARGET : CHALLENGER, state: "COMPLETE" }),
  );
  const createChallenge = vi.fn(async () =>
    ok({ challenge: { id: CHALLENGE }, replayed: false }),
  );
  const acceptChallenge = vi.fn(async () =>
    ok({ challenge: { challengerPlayerId: CHALLENGER, targetPlayerId: TARGET } }),
  );
  const startEncounter = vi.fn(async () => ok({ battleId: BATTLE }));
  const definitions = createPvpWhatsAppRoutes({
    players: { resolvePlayer },
    pvp: {
      createChallenge,
      acceptChallenge,
      startEncounter,
      declineChallenge: vi.fn(),
      cancelChallenge: vi.fn(),
    },
    openChallengeIdForTarget: async () => CHALLENGE,
    openChallengeIdForChallenger: async () => null,
  } as never);
  const gate = new RuntimeCommandPolicyGate({
    community: {
      resolveChat: async () => ({
        known: true as const,
        groupId: "00000000-0000-4000-8000-000000007105",
        role: "GAME" as const,
        capabilities: legacy
          ? (["world", "player.basic"] as const)
          : capabilitiesForWorldGroupSetup("GAME", []),
      }),
    },
    players: { resolvePlayer },
    access: {
      load: async () => ({
        playerId: CHALLENGER,
        status: "ACTIVE" as const,
        approvedReviewId: "00000000-0000-4000-8000-000000007106",
        revision: 1,
      }),
    },
    admins: { capabilitiesFor: async () => [] },
  });
  return { router: new MessageRouter(definitions, gate), createChallenge, acceptChallenge, startEncounter };
}

describe("PvP through the live WhatsApp handlers and GAME policy", () => {
  it("runs /desafiar then /aceitar with real handler logic", async () => {
    const state = setup();
    const challenge = await state.router.dispatch(context("/desafiar @alvo"));
    expect(challenge).toMatchObject({
      ok: true,
      value: { resultRefType: "PVP", resultRefId: CHALLENGE },
    });
    expect(state.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        challengerPlayerId: CHALLENGER,
        targetPlayerId: TARGET,
        formatKey: "1V1",
        reachPolicy: "SAME_AREA",
      }),
    );
    const accepted = await state.router.dispatch(context("/aceitar", TARGET_REF));
    expect(accepted).toMatchObject({
      ok: true,
      value: { resultRefType: "PVP", resultRefId: BATTLE },
    });
    expect(state.acceptChallenge).toHaveBeenCalledWith({
      challengeId: CHALLENGE,
      actorPlayerId: TARGET,
    });
    expect(state.startEncounter).toHaveBeenCalledTimes(1);
  });

  it("denies PvP in a legacy group before invoking either mutation", async () => {
    const state = setup(true);
    expect(await state.router.dispatch(context("/desafiar @alvo"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(await state.router.dispatch(context("/aceitar", TARGET_REF))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(state.createChallenge).not.toHaveBeenCalled();
    expect(state.acceptChallenge).not.toHaveBeenCalled();
    expect(state.startEncounter).not.toHaveBeenCalled();
  });
});
