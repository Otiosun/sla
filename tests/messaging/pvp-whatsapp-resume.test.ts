import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createPvpWhatsAppRoutes } from "../../src/modules/pvp/whatsapp-handlers.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const challengeId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const challengerId = "33333333-3333-4333-8333-333333333333";
const battleId = "44444444-4444-4444-8444-444444444444";

function context(text: string, senderRef = "target@s.whatsapp.net", id = "pvp-inbound"): MessageHandlerContext {
  return {
    inboxMessageId: "inbox",
    correlationId: "correlation",
    causationId: "inbox",
    idempotencyKey: `inbox:baileys:${id}`,
    message: {
      provider: "baileys",
      externalMessageId: id,
      senderRef,
      chatRef: "pvp-game-group@g.us",
      occurredAt: "2026-10-24T22:00:00.000Z",
      text,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function dependencies() {
  const resolvePlayer = vi.fn(async ({ externalId }: { externalId: string }) =>
    ok({
      playerId: externalId.startsWith("challenger") ? challengerId : targetId,
    }),
  );
  const acceptChallenge = vi.fn(async () =>
    ok({
      challenge: {
        id: challengeId,
        challengerPlayerId: challengerId,
        targetPlayerId: targetId,
        status: "ACCEPTED",
      },
      replayed: true,
    }),
  );
  const startEncounter = vi.fn()
    .mockResolvedValueOnce(err(appError("REVISION_CONFLICT", "Transient start conflict")))
    .mockResolvedValue(ok({ battleId, challengeId, replayed: false }));
  const declineChallenge = vi.fn(async () =>
    ok({ challenge: { id: challengeId }, replayed: false }),
  );
  const cancelChallenge = vi.fn(async () =>
    ok({ challenge: { id: challengeId }, replayed: false }),
  );
  const openChallengeIdForTarget = vi.fn(async () => null);
  const actionableChallengeIdForTarget = vi.fn(async () => challengeId);
  const openChallengeIdForChallenger = vi.fn(async () => challengeId);
  const authorize = vi.fn(async () => ok(undefined));
  const router = new MessageRouter(
    createPvpWhatsAppRoutes({
      players: { resolvePlayer },
      pvp: {
        createChallenge: vi.fn(),
        acceptChallenge,
        startEncounter,
        declineChallenge,
        cancelChallenge,
      },
      openChallengeIdForTarget,
      actionableChallengeIdForTarget,
      openChallengeIdForChallenger,
    } as never),
    { authorize },
  );
  return {
    router, authorize, resolvePlayer, acceptChallenge, startEncounter,
    declineChallenge, cancelChallenge, openChallengeIdForTarget,
    actionableChallengeIdForTarget, openChallengeIdForChallenger,
  };
}

describe("PVP WhatsApp lifecycle and interrupted-start recovery", () => {
  it("resumes accepted invitation after start conflict without looking up a new OPEN challenge", async () => {
    const d = dependencies();
    const first = await d.router.dispatch(context("/aceitar", "target@s.whatsapp.net", "accept-1"));
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        details: { userMessage: expect.stringContaining("Use `/aceitar` novamente") },
      },
    });
    const second = await d.router.dispatch(context("/aceitar", "target@s.whatsapp.net", "accept-2"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const text = String(second.value?.outgoing[0]?.payload.text);
    expect(text).toContain("𝗣𝗩𝗣 𝗜𝗡𝗜𝗖𝗜𝗔𝗗𝗢");
    expect(text).toContain("`/batalha`");
    expect(text).not.toContain(battleId);
    expect(d.acceptChallenge).toHaveBeenCalledTimes(2);
    expect(d.startEncounter).toHaveBeenCalledTimes(2);
    expect(d.startEncounter).toHaveBeenCalledWith({
      challengeId,
      actorPlayerId: targetId,
    });
    expect(d.actionableChallengeIdForTarget).toHaveBeenCalledTimes(2);
    expect(d.openChallengeIdForTarget).not.toHaveBeenCalled();
    expect(d.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredGroupCapabilities: ["pvp"] }),
    );
  });

  it("keeps decline restricted to OPEN invitations and never starts a battle", async () => {
    const d = dependencies();
    const unavailable = await d.router.dispatch(context("/recusar"));
    expect(unavailable).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(d.declineChallenge).not.toHaveBeenCalled();
    expect(d.acceptChallenge).not.toHaveBeenCalled();
    expect(d.startEncounter).not.toHaveBeenCalled();

    d.openChallengeIdForTarget.mockResolvedValue(challengeId);
    const declined = await d.router.dispatch(context("/recusar", "target@s.whatsapp.net", "decline-2"));
    expect(declined.ok).toBe(true);
    if (declined.ok) {
      expect(declined.value?.outgoing[0]?.payload.text).toContain("Nenhuma batalha foi iniciada");
      expect(JSON.stringify(declined.value?.outgoing)).not.toContain(challengeId);
    }
    expect(d.declineChallenge).toHaveBeenCalledWith({
      challengeId,
      actorPlayerId: targetId,
    });
    expect(d.startEncounter).not.toHaveBeenCalled();
  });

  it("cancels only through challenger identity without initiating a turn", async () => {
    const d = dependencies();
    const cancelled = await d.router.dispatch(context(
      "/cancelar", "challenger@s.whatsapp.net", "cancel-1",
    ));
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value?.outgoing[0]?.payload.text).toContain("DESAFIO");
      expect(cancelled.value?.outgoing[0]?.payload.text).toContain("encerrado antes da batalha");
    }
    expect(d.cancelChallenge).toHaveBeenCalledWith({
      challengeId,
      actorPlayerId: challengerId,
    });
    expect(d.startEncounter).not.toHaveBeenCalled();
    expect(d.openChallengeIdForTarget).not.toHaveBeenCalled();
  });

  it("does not mutate the invitation when the group policy rejects PvP", async () => {
    const d = dependencies();
    d.authorize.mockResolvedValue(err(appError("PLAYER_INELIGIBLE", "PVP disabled here")));
    const result = await d.router.dispatch(context("/aceitar"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLAYER_INELIGIBLE" },
    });
    expect(d.resolvePlayer).not.toHaveBeenCalled();
    expect(d.actionableChallengeIdForTarget).not.toHaveBeenCalled();
    expect(d.acceptChallenge).not.toHaveBeenCalled();
    expect(d.startEncounter).not.toHaveBeenCalled();
  });
});
