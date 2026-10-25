import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { createProgressionWhatsAppRoutes } from "../../src/modules/progression/whatsapp-handlers.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const SENDER = "shadow-progress@s.whatsapp.net";

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "progress-inbox",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "progress-inbox",
    idempotencyKey: `progress-route:${command}`,
    message: {
      provider: "baileys",
      externalMessageId: `progress:${command}`,
      senderRef: SENDER,
      chatRef: "progress-shadow@g.us",
      occurredAt: "2026-10-24T18:00:00.000Z",
      text: command,
      mediaRefs: [],
      replyToExternalMessageId: null,
    },
  };
}

function fixture(
  status: "ACTIVE" | "SUSPENDED" | "PENDING",
  state: "COMPLETE" | "NEW" = "COMPLETE",
) {
  const readChoices = vi.fn(async () => []);
  const readOwned = vi.fn(async () => []);
  const readEvolution = vi.fn(async () => []);
  const resolveChoice = vi.fn();
  const evolvePokemon = vi.fn();
  const handlerResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const authResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const accessLoad = vi.fn(async () => ({
    playerId: PLAYER_ID,
    status,
    approvedReviewId: status === "PENDING" ? null : "00000000-0000-4000-8000-000000000051",
    revision: 2,
  }));
  const routes = createProgressionWhatsAppRoutes({
    players: { resolvePlayer: handlerResolve },
    reads: {
      activeBattleId: vi.fn(async () => null),
      listPendingMoveChoices: readChoices,
      listOwnedPokemon: readOwned,
      listEvolutionOptions: readEvolution,
    },
    progression: { resolveMoveChoice: resolveChoice, evolvePokemon },
  } as never);
  const groupLookup = vi.fn(async () => ({
    known: false,
    groupId: null,
    role: null,
    capabilities: [],
  }));
  const gate = new RuntimeCommandPolicyGate({
    community: { resolveChat: groupLookup },
    players: { resolvePlayer: authResolve },
    access: { load: accessLoad },
    admins: { capabilitiesFor: vi.fn(async () => []) },
  } as never);
  return {
    routes,
    router: new MessageRouter(routes, gate),
    groupLookup,
    authResolve,
    handlerResolve,
    accessLoad,
    readChoices,
    readOwned,
    readEvolution,
    resolveChoice,
    evolvePokemon,
  };
}

describe("progression command access policy", () => {
  it("requires ACTIVE and COMPLETE for every move and evolution route, including aliases", () => {
    const { routes } = fixture("ACTIVE");
    expect(routes.map((route) => route.command)).toEqual([
      "golpes",
      "aprender",
      "evolucao",
      "evoluir",
    ]);
    for (const route of routes) {
      expect(route.policy).toEqual({
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      });
      expect(route.policy?.requiredGroupCapabilities).toBeUndefined();
    }
    expect(routes.find((route) => route.command === "golpes")?.aliases).toContain("movimentos");
  });

  it.each(["SUSPENDED", "PENDING"] as const)(
    "rejects %s before any progression handler or read model executes",
    async (status) => {
      const f = fixture(status);
      for (const command of [
        "/golpes",
        "/movimentos",
        "/aprender 1 3",
        "/evolucao Eevee",
        "/evoluir Eevee 1",
      ]) {
        const outcome = await f.router.dispatch(context(command));
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: "PLAYER_INELIGIBLE" },
        });
      }
      expect(f.authResolve).toHaveBeenCalledTimes(5);
      expect(f.accessLoad).toHaveBeenCalledTimes(5);
      expect(f.handlerResolve).not.toHaveBeenCalled();
      expect(f.readChoices).not.toHaveBeenCalled();
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(f.readEvolution).not.toHaveBeenCalled();
      expect(f.resolveChoice).not.toHaveBeenCalled();
      expect(f.evolvePokemon).not.toHaveBeenCalled();
      // Existing player progression UX stays available outside configured group chats.
      expect(f.groupLookup).not.toHaveBeenCalled();
    },
  );

  it("rejects an ACTIVE account before onboarding is mechanically COMPLETE", async () => {
    const f = fixture("ACTIVE", "NEW");
    const outcome = await f.router.dispatch(context("/aprender 1 3"));
    expect(outcome).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(f.resolveChoice).not.toHaveBeenCalled();
    expect(f.handlerResolve).not.toHaveBeenCalled();
  });

  it("rejects unknown identities even if no configured group exists", async () => {
    const f = fixture("ACTIVE");
    const unknown = new RuntimeCommandPolicyGate({
      community: { resolveChat: f.groupLookup },
      players: {
        resolvePlayer: async () => err(appError("NOT_FOUND", "No linked player")),
      },
      access: { load: f.accessLoad },
      admins: { capabilitiesFor: async () => [] },
    } as never);
    const router = new MessageRouter(f.routes, unknown);
    const result = await router.dispatch(context("/evoluir Eevee 1"));
    expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(f.accessLoad).not.toHaveBeenCalled();
    expect(f.evolvePokemon).not.toHaveBeenCalled();
  });

  it("keeps ACTIVE, COMPLETE move queries accessible without a configured group", async () => {
    const f = fixture("ACTIVE");
    const outcome = await f.router.dispatch(context("/golpes"));
    expect(outcome.ok).toBe(true);
    expect(f.readChoices).toHaveBeenCalledTimes(1);
    expect(f.groupLookup).not.toHaveBeenCalled();
  });
});
