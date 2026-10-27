import { describe, expect, it, vi } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import { PlayerPortalEvolutionService } from "../../src/modules/player-portal/evolution-service.js";
import type { ProgressionService } from "../../src/modules/progression/service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok, err, appError } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const identity = { provider: "baileys", externalId: "player@test" } as const;
const requestId = "11111111-1111-4111-8111-111111111111";
const formId = "22222222-2222-4222-8222-222222222222";
const newFormId = "33333333-3333-4333-8333-333333333333";
const profile: PlayerProfileView = {
  playerId, playerStatus: "ACTIVE", trainerName: "Natan", originRegionId: null,
  locale: "pt-BR", trainerLevel: 1, progressionPoints: 0n,
  onboardingState: "COMPLETE",
  contentReleaseId: "44444444-4444-4444-8444-444444444444",
  rulesetId: "55555555-5555-4555-8555-555555555555",
  starterPokemonInstanceId: pokemonInstanceId, team: [],
};

function fixture(options: { activeBattle?: boolean; status?: PlayerProfileView["playerStatus"] } = {}) {
  const evolvePokemon = vi.fn<ProgressionService["evolvePokemon"]>(async () =>
    ok({
      pokemonInstanceId, fromFormId: formId, toFormId: newFormId,
      triggerKind: "ITEM", beforeLevel: 16, afterLevel: 16, replayed: false,
    }),
  );
  return {
    evolvePokemon,
    subject: new PlayerPortalEvolutionService({
      players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
      profiles: { getProfile: async () => ok({
        ...profile, playerStatus: options.status ?? profile.playerStatus,
      }) },
      reads: { activeBattleId: async () => options.activeBattle ? "battle-id" : null },
      progression: { evolvePokemon },
    }),
  };
}
const request = { pokemonInstanceId, requestId, trigger: { kind: "ITEM", itemId: formId } };

describe("PlayerPortalEvolutionService", () => {
  it("lists only owned Pokémon evolution rules with serialized item quantities", async () => {
    const listEvolutionOptions = vi.fn(async () => [{
      targetDisplayName: "Charmeleon",
      triggerKind: "ITEM" as const,
      requiredLevel: null,
      relativePhysicalStats: null,
      itemId: "66666666-6666-4666-8666-666666666666",
      itemDisplayName: "Pedra evolutiva",
      itemQuantity: 2n,
      conditionActive: null,
    }]);
    const subject = new PlayerPortalEvolutionService({
      players: { resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }) },
      profiles: { getProfile: async () => ok(profile) },
      reads: {
        activeBattleId: async () => "active-battle",
        listEvolutionOptions,
      },
      progression: { evolvePokemon: async () => ok({
        pokemonInstanceId, fromFormId: formId, toFormId: newFormId,
        triggerKind: "ITEM", beforeLevel: 16, afterLevel: 16, replayed: false,
      }) },
    });
    expect(await subject.listOptions(identity, pokemonInstanceId)).toMatchObject({
      ok: true,
      value: {
        blockedByBattle: true,
        options: [{
          itemQuantity: "2",
          itemDisplayName: "Pedra evolutiva",
          targetDisplayName: "Charmeleon",
        }],
      },
    });
    expect(listEvolutionOptions).toHaveBeenCalledWith(playerId, pokemonInstanceId);
    expect((await subject.listOptions(identity, "not-a-pokemon-id")).ok).toBe(false);
    expect(listEvolutionOptions).toHaveBeenCalledTimes(1);
  });

  it("runs canonical progression only as the authenticated player and namespaces retry keys", async () => {
    const { subject, evolvePokemon } = fixture();
    const result = await subject.evolve(identity, request);
    expect(result).toMatchObject({ ok: true, value: { toFormId: newFormId } });
    expect(evolvePokemon).toHaveBeenCalledOnce();
    expect(evolvePokemon.mock.calls[0]?.[0]).toMatchObject({
      playerId, pokemonInstanceId,
      idempotencyKey: `hub.evolution:${playerId}:${requestId}`,
      trigger: { kind: "ITEM", itemId: formId },
    });
  });

  it("rejects active battles, incomplete players and invalid payloads without writes", async () => {
    for (const [opts, payload] of [
      [{ activeBattle: true }, request],
      [{ status: "BANNED" as PlayerProfileView["playerStatus"] }, request],
      [{}, { ...request, pokemonInstanceId: "wrong" }],
      [{}, { ...request, trigger: { kind: "ITEM", itemId: "invalid" } }],
      [{}, { ...request, trigger: { kind: "CONDITION", formId: newFormId } }],
    ] as const) {
      const { subject, evolvePokemon } = fixture(opts);
      expect((await subject.evolve(identity, payload)).ok).toBe(false);
      expect(evolvePokemon).not.toHaveBeenCalled();
    }
  });

  it("does not disguise item failure or conflicting replay as a successful evolution", async () => {
    const { subject, evolvePokemon } = fixture();
    evolvePokemon.mockResolvedValueOnce(err(appError("ACTION_INVALID", "item missing", {
      progressionCode: "EVOLUTION_ITEM_MISSING",
    })) as Awaited<ReturnType<ProgressionService["evolvePokemon"]>>);
    const result = await subject.evolve(identity, request);
    expect(result.ok).toBe(false);
  });
});
