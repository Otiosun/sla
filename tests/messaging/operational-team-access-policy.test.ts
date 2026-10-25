import { describe, expect, it, vi } from "vitest";
import { RuntimeCommandPolicyGate } from "../../src/modules/community/runtime-command-policy-gate.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";
import { presentMessagingError } from "../../src/modules/messaging/errors.js";
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
      nickname: null as string | null,
      level: 5,
      xp: 0n,
      currentHp: 19,
      placementKind: "TEAM" as "TEAM" | "BOX",
      boxNo: null as number | null,
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
    world: {},
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

  it.each(["0", "7", "99", "1.5", "-1", "2e1", "abc"] as const)(
    "explains invalid team slot %s before any storage or gameplay calls",
    async (slot) => {
      const f = fixture("ACTIVE");
      const command = `/equipe colocar #13 ${slot}`;
      const result = await f.router.dispatch(context(command));
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      if (result.ok) return;
      expect(result.error.message).toContain("Slot inválido");
      expect(result.error.message).toContain("1 a 6");
      const shown = presentMessagingError(context(command), result.error);
      expect(shown.outgoing[0]?.payload.text).toContain("Slot inválido");
      expect(shown.outgoing[0]?.payload.text).toContain("/equipe colocar #13 2");
      expect(f.authResolve).toHaveBeenCalledTimes(1);
      expect(f.listOwnedPokemon).toHaveBeenCalledTimes(1);
      expect(f.activeBattleId).not.toHaveBeenCalled();
      expect(f.activeForPlayer).not.toHaveBeenCalled();
      expect(f.getStorage).not.toHaveBeenCalled();
      expect(f.move).not.toHaveBeenCalled();
    },
  );

  it("explains invalid slots after a species name rather than reporting a missing Pokémon", async () => {
    const f = fixture("ACTIVE");
    const result = await f.router.dispatch(context("/equipe colocar Charmander 7"));
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (result.ok) return;
    expect(result.error.message).toContain("Slot inválido");
    expect(f.move).not.toHaveBeenCalled();
  });

  it.each([1, 6] as const)("accepts explicit team slot %s", async (slot) => {
    const f = fixture("ACTIVE");
    const result = await f.router.dispatch(context(`/equipe colocar #13 ${slot}`));
    expect(result.ok).toBe(true);
    expect(f.move).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      target: { placementKind: "TEAM", boxNo: null, slotNo: slot },
    });
    expect(f.groupLookup).not.toHaveBeenCalled();
  });

  it("treats an exact nickname ending in a number as a Pokémon reference", async () => {
    const f = fixture("ACTIVE");
    f.listOwnedPokemon.mockResolvedValue([
      {
        collectionNo: 13,
        pokemonInstanceId: POKEMON_ID,
        displayName: "Charmander",
        nickname: "Rex 7",
        level: 5,
        xp: 0n,
        currentHp: 19,
        placementKind: "TEAM" as const,
        boxNo: null,
        slotNo: 1,
      },
    ]);
    const result = await f.router.dispatch(context("/equipe colocar Rex 7"));
    expect(result.ok).toBe(true);
    expect(f.move).toHaveBeenCalledWith({
      playerId: PLAYER_ID,
      pokemonInstanceId: POKEMON_ID,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    });
  });

  it("keeps the suspension gate ahead of invalid slot input and collection reads", async () => {
    const f = fixture("SUSPENDED");
    const result = await f.router.dispatch(context("/equipe colocar #13 7"));
    expect(result).toMatchObject({ ok: false, error: { code: "PLAYER_INELIGIBLE" } });
    expect(f.listOwnedPokemon).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("renders the team in real slot order and keeps the panel read-only", async () => {
    const f = fixture("SUSPENDED");
    f.listOwnedPokemon.mockResolvedValue([
      {
        collectionNo: 13,
        pokemonInstanceId: POKEMON_ID,
        displayName: "Charmander",
        nickname: null,
        level: 5,
        xp: 0n,
        currentHp: 19,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 3,
      },
      {
        collectionNo: 14,
        pokemonInstanceId: "00000000-0000-4000-8000-000000000026",
        displayName: "Bulbasaur",
        nickname: null,
        level: 5,
        xp: 0n,
        currentHp: 20,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      },
    ]);
    const result = await f.router.dispatch(context("/equipe"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shown = result.value?.outgoing[0]?.payload.text ?? "";
    expect(shown.indexOf("*Bulbasaur*")).toBeLessThan(shown.indexOf("*Charmander*"));
    expect(shown).toContain("slot 1");
    expect(shown).toContain("slot 3");
    expect(f.authResolve).not.toHaveBeenCalled();
    expect(f.getStorage).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("does not reorganize a Pokémon that is already on the team without a target slot", async () => {
    const f = fixture("ACTIVE");
    const result = await f.router.dispatch(context("/equipe colocar #13"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.outgoing[0]?.payload.text).toContain("Equipe sem mudanças");
    expect(result.value?.outgoing[0]?.payload.text).toContain("já está no slot 1");
    expect(f.activeBattleId).not.toHaveBeenCalled();
    expect(f.activeForPlayer).not.toHaveBeenCalled();
    expect(f.getStorage).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("explains the displaced Pokémon and its destination after a confirmed slot swap", async () => {
    const f = fixture("ACTIVE");
    const otherId = "00000000-0000-4000-8000-000000000026";
    f.listOwnedPokemon.mockResolvedValue([
      {
        collectionNo: 13,
        pokemonInstanceId: POKEMON_ID,
        displayName: "Charmander",
        nickname: null,
        level: 5,
        xp: 0n,
        currentHp: 19,
        placementKind: "BOX",
        boxNo: 1,
        slotNo: 7,
      },
      {
        collectionNo: 14,
        pokemonInstanceId: otherId,
        displayName: "Bulbasaur",
        nickname: "Verde",
        level: 6,
        xp: 0n,
        currentHp: 20,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 2,
      },
    ]);
    f.move.mockResolvedValue(
      ok({
        kind: "APPLIED",
        pokemonInstanceId: POKEMON_ID,
        fromPlacementKind: "BOX",
        fromBoxNo: 1,
        fromSlotNo: 7,
        toPlacementKind: "TEAM",
        toBoxNo: null,
        toSlotNo: 2,
        swappedPokemonInstanceId: otherId,
      }),
    );
    const result = await f.router.dispatch(context("/equipe colocar #13 2"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shown = result.value?.outgoing[0]?.payload.text ?? "";
    expect(shown).toContain("#13 agora está no slot 2");
    expect(shown).toContain("#14 *Verde* foi para Box 1, slot 7");
    expect(shown).not.toContain(POKEMON_ID);
    expect(shown).not.toContain(otherId);
    expect(f.move).toHaveBeenCalledTimes(1);
  });

  it("shows collection numbers when the Pokémon species name is ambiguous before a requested slot", async () => {
    const f = fixture("ACTIVE");
    f.listOwnedPokemon.mockResolvedValue([
      {
        collectionNo: 13,
        pokemonInstanceId: POKEMON_ID,
        displayName: "Charmander",
        nickname: null,
        level: 5,
        xp: 0n,
        currentHp: 19,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      },
      {
        collectionNo: 14,
        pokemonInstanceId: "00000000-0000-4000-8000-000000000026",
        displayName: "Charmander",
        nickname: null,
        level: 6,
        xp: 0n,
        currentHp: 20,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 2,
      },
    ]);
    const result = await f.router.dispatch(context("/equipe colocar Charmander 2"));
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (result.ok) return;
    const shown = presentMessagingError(context("/equipe colocar Charmander 2"), result.error);
    expect(shown.outgoing[0]?.payload.text).toContain("#13");
    expect(shown.outgoing[0]?.payload.text).toContain("#14");
    expect(f.getStorage).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
  });

  it("rejects a name that can also be parsed as a different Pokémon plus a valid slot", async () => {
    const f = fixture("ACTIVE");
    const otherId = "00000000-0000-4000-8000-000000000026";
    f.listOwnedPokemon.mockResolvedValue([
      {
        collectionNo: 13,
        pokemonInstanceId: POKEMON_ID,
        displayName: "Rex",
        nickname: null,
        level: 5,
        xp: 0n,
        currentHp: 19,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      },
      {
        collectionNo: 14,
        pokemonInstanceId: otherId,
        displayName: "Rex 2",
        nickname: null,
        level: 6,
        xp: 0n,
        currentHp: 20,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 2,
      },
    ]);
    const result = await f.router.dispatch(context("/equipe colocar Rex 2"));
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    if (result.ok) return;
    expect(result.error.message).toContain("Nome e slot ambíguos");
    expect(result.error.message).toContain("/equipe colocar #13 2");
    expect(result.error.message).toContain("/equipe colocar #14");
    expect(f.getStorage).not.toHaveBeenCalled();
    expect(f.move).not.toHaveBeenCalled();
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
