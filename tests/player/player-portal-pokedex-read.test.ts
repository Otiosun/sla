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

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: null,
  locale: "pt-BR",
  trainerLevel: 7,
  progressionPoints: 1234n,
  onboardingState: "COMPLETE",
  contentReleaseId: "22222222-2222-4222-8222-222222222222",
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: createPokemonInstanceId(),
  team: [],
};

function repository(): PlayerOnboardingRepository {
  const transaction = {
    findPlayerByIdentity: async () => playerId,
    loadProfileView: async () => profile,
    listPokedexSpecies: async () => [
      {
        nationalDex: 4,
        seenCount: 3n,
        caughtCount: 1n,
        firstSeenAt: new Date("2026-09-01T10:00:00.000Z"),
        lastSeenAt: new Date("2026-09-08T12:30:00.000Z"),
        firstCaughtAt: new Date("2026-09-02T11:00:00.000Z"),
        lastCaughtAt: new Date("2026-09-02T11:00:00.000Z"),
      },
    ],
  } as unknown as PlayerOnboardingTransaction;

  return {
    read: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) => work(transaction),
    transaction: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) => work(transaction),
  };
}

describe("PlayerPortalReadService Pokedex", () => {
  it("returns only the authenticated player's authoritative discovery counters as JSON-safe values", async () => {
    const service = new PlayerPortalReadService(repository());

    const result = await service.getPokedex(identity);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          nationalDex: 4,
          seenCount: "3",
          caughtCount: "1",
          firstSeenAt: "2026-09-01T10:00:00.000Z",
          lastSeenAt: "2026-09-08T12:30:00.000Z",
          firstCaughtAt: "2026-09-02T11:00:00.000Z",
          lastCaughtAt: "2026-09-02T11:00:00.000Z",
        },
      ],
    });
  });
});
