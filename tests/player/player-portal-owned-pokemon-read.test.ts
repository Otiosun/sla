import { describe, expect, it } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import type {
  PlayerOnboardingRepository,
  PlayerOnboardingTransaction,
} from "../../src/modules/player/ports.js";
import { PlayerPortalReadService } from "../../src/modules/player-portal/read-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

const identity = { provider: "whatsapp", externalId: "5511999999999" } as const;
const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const contentReleaseId = "22222222-2222-4222-8222-222222222222";
const formId = "44444444-4444-4444-8444-444444444444";

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: "11111111-1111-4111-8111-111111111111",
  locale: "pt-BR",
  trainerLevel: 7,
  progressionPoints: 1234n,
  onboardingState: "COMPLETE",
  contentReleaseId,
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: pokemonInstanceId,
  team: [],
};

function repository(): PlayerOnboardingRepository {
  const transaction = {
    findPlayerByIdentity: async () => playerId,
    loadProfileView: async () => profile,
    listOwnedPokemon: async () => [
      {
        pokemonInstanceId,
        formId,
        nickname: "Brasa",
        level: 12,
        currentHp: 31,
        gender: "M",
        shiny: true,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      },
    ],
  } as unknown as PlayerOnboardingTransaction;

  return {
    read: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) => work(transaction),
    transaction: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) =>
      work(transaction),
  };
}

describe("PlayerPortalReadService owned Pokemon", () => {
  it("returns authoritative owned instances enriched from the active content release", async () => {
    let catalogInput: unknown;
    const service = new PlayerPortalReadService(repository(), {
      resolve: async (input) => {
        catalogInput = input;
        return {
          originRegionName: null,
          forms: [
            {
              formId,
              displayName: "Charmander",
              nationalDex: 4,
              typeNames: ["Fire"],
            },
          ],
        };
      },
    });

    const result = await service.getPokemon(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(catalogInput).toEqual({
      contentReleaseId,
      originRegionId: null,
      formIds: [formId],
    });
    expect(result.value).toEqual([
      {
        pokemonInstanceId,
        formId,
        displayName: "Charmander",
        nationalDex: 4,
        typeNames: ["Fire"],
        nickname: "Brasa",
        level: 12,
        currentHp: 31,
        gender: "M",
        shiny: true,
        placementKind: "TEAM",
        boxNo: null,
        slotNo: 1,
      },
    ]);
  });

  it("keeps unresolved catalog data explicit instead of inventing species presentation", async () => {
    const service = new PlayerPortalReadService(repository(), {
      resolve: async () => ({ originRegionName: null, forms: [] }),
    });

    const result = await service.getPokemon(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      pokemonInstanceId,
      displayName: null,
      nationalDex: null,
      typeNames: [],
    });
  });
});
