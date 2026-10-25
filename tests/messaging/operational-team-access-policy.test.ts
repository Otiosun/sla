import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const PLAYER_ID = "00000000-0000-4000-8000-000000000013";
const POKEMON_ID = "00000000-0000-4000-8000-000000000025";

function context(command: string): MessageHandlerContext {
  return {
    inboxMessageId: "team-policy-inbox",
    correlationId: "00000000-0000-4000-8000-000000000031",
    causationId: "team-policy-inbox",
    idempotencyKey: "team-policy-action",
    message: {
      provider: "baileys",
      externalMessageId: "team-policy-message",
      senderRef: "shadow-team@s.whatsapp.net",
      chatRef: "shadow-team@g.us",
      occurredAt: "2026-10-25T03:00:00.000Z",
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
  const handlerResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const authResolve = vi.fn(async () => ok({ playerId: PLAYER_ID, state, created: false }));
  const accessLoad = vi.fn(async () => ({
    playerId: PLAYER_ID,
    status,
    approvedReviewId: status === "PENDING" ? null : "00000000-0000-4000-8000-000000000051",
    revision: 2,
  }));
  const listOwnedPokemon = vi.fn(async () => [
    {
      collectionNo: 13,
      pokemonInstanceId: POKEMON_ID,
      displayName: "Charmander",
      nickname: null,
      level: 5,
      xp: 0n,
      currentHp: 19,
      placementKind: "TEAM" as const,
      boxNo: null,
      slotNo: 1,
    },
  ]);
  const activeBattleId = vi.fn(async () => null);
  const activeForPlayer = vi.fn(async () => err(appError("NOT_FOUND", "No encounter")));
  const getStorage = vi.fn(async () =>
    ok({
      playerId: PLAYER_ID,
      team: [
        {
          pokemonInstanceId: POKEMON_ID,
          displayName: "Charmander",
          level: 5,
          placementKind: "TEAM",
          boxNo: null,
          slotNo: 1,
        },
      ],
      boxes: [],
    }),
  );
  const move = vi.fn(async () => ok({}));
  const routes = createOperationalUxRoutes({
    registration: { resolvePlayer: handlerResolve },
    reads: { listOwnedPokemon, activeBattleId },
    encounter: { activeForPlayer },
    pcStorage: { getStorage, move },
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
    handlerResolve,
    authResolve,
    accessLoad,
    listOwnedPokemon,
    activeBattleId,
    activeForPlayer,
    getStorage,
    move,
    groupLookup,
  };
}

describe("legacy team read vs mutation access policy", () => {
  it("keeps team read-only while guarding actions before dispatching the handler", () => {
    const f = fixture("ACTIVE");
    const route = f.routes.find((candidate) => candidate.command === "equipe");
    expect(route?.policy).toBeUndefined();
    expect(route?.policyForContext?.(context("/equipe"))).toBeUndefined();
    expect(route?.policyForContext?.(context("/equipe guardar #13"))).toEqual({
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    });
    expect(route?.policyForContext?.(context("/equipe colocar #13 2"))).toEqual({
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    });
  });

  it.each(["SUSPENDED", "PENDING"] as const)(
    "blocks %s team mutation before any roster read or storage write",
    async (status) => {
      const f = fixture(status);
      for (const command of [
        "/equipe guardar #13",
        "/equipe colocar #13 2",
        "Quero guardar meu Pokémon: /equipe guardar #13",
      ]) {
        const result = await f.router.dispatch(context(command));
        expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
      }
      expect(f.authResolve).toHaveBeenCalledTimes(3);
      expect(f.accessLoad).toHaveBeenCalledTimes(3);
      expect(f.handlerResolve).not.toHaveBeenCalled();
      expect(f.listOwnedPokemon).not.toHaveBeenCalled();
      expect(f.activeBattleId).not.toHaveBeenCalled();
      expect(f.activeForPlayer).not.toHaveBeenCalled();
      expect(f.getStorage).not.toHaveBeenCalled();
      expect(f.move).not.toHaveBeenCalled();
      expect(f.groupLookup).not.toHaveBeenCalled();
    },
  );

  it("blocks ACTIVE trainers with incomplete mechanical onboarding from moving Pokémon", async () => {
    const f = fixture("ACTIVE", "NEW");
    const result = await f.router.dispatch(context("/equipe guardar #13"));
    expect(result).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(f.handlerResolve).not.toHaveBeenCalled();
    expect(f.listOwnedPokemon).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("keeps a suspended trainer's read-only team panel available", async () => {
    const f = fixture("SUSPENDED");
    const result = await f.router.dispatch(context("/equipe"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.outgoing[0]?.payload.text).toContain("Charmander");
    expect(f.handlerResolve).toHaveBeenCalledTimes(1);
    expect(f.listOwnedPokemon).toHaveBeenCalledTimes(1);
    expect(f.authResolve).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("allows ACTIVE, COMPLETE roster mutations outside a configured game group", async () => {
    const f = fixture("ACTIVE");
    const result = await f.router.dispatch(context("/equipe guardar #13"));
    expect(result.ok).toBe(true);
    expect(f.move).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 1 },
    });
    expect(f.groupLookup).not.toHaveBeenCalled();
  });

  it("fails closed without a policy gate only for the modifying variant", async () => {
    const f = fixture("ACTIVE");
    const app = new MessageRouter(f.routes);
    expect(await app.dispatch(context("/equipe guardar #13"))).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(f.handlerResolve).not.toHaveBeenCalled();
    expect((await app.dispatch(context("/equipe"))).ok).toBe(true);
  });
});
