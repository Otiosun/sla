import { describe, expect, it, vi } from "vitest";
import { normalizeBaileysMessage } from "../../src/adapters/whatsapp/baileys-normalizer.js";
import { createUatBootstrapRoutes } from "../../src/modules/admin/uat-bootstrap.js";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type {
  InboxClaim,
  IncomingMessage,
  MessageHandlerResult,
} from "../../src/modules/messaging/contracts.js";
import type { MessagingRepository } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const LID = "123456789012345@lid";
const PN = "5511999999999@s.whatsapp.net";
const CHAT = "120363000000000000@g.us";
const PLAYER_ID = createPlayerId();

function inbound(externalMessageId: string): IncomingMessage {
  const normalized = normalizeBaileysMessage(
    {
      key: {
        id: externalMessageId,
        remoteJid: CHAT,
        participant: LID,
        fromMe: false,
      },
      messageTimestamp: 1_700_000_000,
      message: { conversation: "/teste" },
    },
    new Map([[LID, PN]]),
  );
  if (normalized === null) throw new Error("expected valid Baileys inbound");
  return normalized;
}

function repository(outgoing: MessageHandlerResult[]): MessagingRepository {
  const claims = new Map<string, InboxClaim>();
  return {
    claimIncoming: async (message) => {
      const replay = claims.get(message.externalMessageId);
      if (replay !== undefined) return ok({ ...replay, status: "REPLAYED" as const });
      const claim: InboxClaim = {
        status: "CLAIMED",
        inboxMessageId: `inbox:${message.externalMessageId}`,
        correlationId: `correlation:${message.externalMessageId}`,
        message,
        resultRefType: null,
        resultRefId: null,
      };
      claims.set(message.externalMessageId, claim);
      return ok(claim);
    },
    consumeRateLimits: async () =>
      ok({ allowed: true, replayed: false, limitedScope: null, retryAfterMs: 0 }),
    completeIncoming: async (_inboxMessageId, result) => {
      outgoing.push(result);
      return ok(undefined);
    },
    failIncoming: async () => {},
    claimOutbox: async () => [],
    markOutboxSent: async () => {},
    markOutboxFailed: async () => {},
    claimMediaJobs: async () => [],
    markMediaJobProcessed: async () => {},
    markMediaJobFailed: async () => {},
  };
}

describe("live UAT /teste ingress after GAME group registration", () => {
  it("canonicalizes a proven LID alias, admits the owner after registration, and keeps distinct provider messages distinct", async () => {
    let groupRegistered = false;
    const resolvePrincipal = vi.fn(async ({ externalId }: { externalId: string }) =>
      externalId === PN ? { principalId: "admin-owner" } : null,
    );
    const capabilitiesFor = vi.fn(async ({ externalId }: { externalId: string }) =>
      externalId === PN ? ["UAT_BOOTSTRAP"] : [],
    );
    const routes = createUatBootstrapRoutes({
      admins: { resolvePrincipal },
      service: {
        status: async () => ok("status"),
        bootstrap: async () =>
          ok({
            playerId: "player",
            access: "ACTIVE",
            area: "UAT Zhoulia",
            party: null,
            uat: true,
            roster: true,
          }),
        prepare: async () =>
          ok([
            {
              playerId: "player-a",
              access: "ACTIVE",
              area: "UAT Zhoulia",
              party: null,
              uat: true,
              roster: true,
            },
            {
              playerId: "player-b",
              access: "ACTIVE",
              area: "UAT Zhoulia",
              party: null,
              uat: true,
              roster: true,
            },
          ]),
      },
    });
    const gate = new RuntimeCommandPolicyGate({
      community: {
        resolveChat: async () =>
          groupRegistered
            ? { known: true, groupId: "game-group", role: "GAME", capabilities: ["world"] }
            : { known: false, groupId: null, role: null, capabilities: [] },
      },
      admins: { capabilitiesFor },
      players: { resolvePlayer: async () => ok({ playerId: PLAYER_ID, state: "COMPLETE" }) },
      access: {
        load: async () => ({
          playerId: PLAYER_ID,
          status: "ACTIVE",
          approvedReviewId: null,
          revision: 1,
        }),
      },
    });
    const outgoing: MessageHandlerResult[] = [];
    const messaging = new MessagingService(repository(outgoing), new MessageRouter(routes, gate));

    const beforeRegistration = inbound("wamid-before-registration");
    expect(beforeRegistration.senderRef).toBe(PN);
    await messaging.receive(beforeRegistration);
    expect(resolvePrincipal).not.toHaveBeenCalled();

    groupRegistered = true;
    const first = inbound("wamid-after-registration-1");
    const second = inbound("wamid-after-registration-2");
    await messaging.receive(first);
    await messaging.receive(second);
    await messaging.receive(first);

    expect(resolvePrincipal).toHaveBeenCalledTimes(2);
    expect(resolvePrincipal).toHaveBeenLastCalledWith({ provider: "baileys", externalId: PN });
    expect(capabilitiesFor).toHaveBeenCalledTimes(2);
    expect(capabilitiesFor).toHaveBeenLastCalledWith({ provider: "baileys", externalId: PN });
    expect(outgoing).toHaveLength(3);
    expect(outgoing.slice(1).map((result) => result.outgoing[0]?.idempotencyKey)).toEqual([
      "inbox:baileys:wamid-after-registration-1:uat-help",
      "inbox:baileys:wamid-after-registration-2:uat-help",
    ]);
    expect(
      outgoing.slice(1).every((result) => typeof result.outgoing[0]?.payload.text === "string"),
    ).toBe(true);
  });
});
