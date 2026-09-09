import { describe, expect, it } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import type {
  PlayerOnboardingRepository,
  PlayerOnboardingTransaction,
} from "../../src/modules/player/ports.js";
import { PlayerPortalReadService } from "../../src/modules/player-portal/read-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";

const identity = {
  provider: "whatsapp",
  externalId: "5511999999999",
} as const;

function profileView(overrides: Partial<PlayerProfileView> = {}): PlayerProfileView {
  return {
    playerId: createPlayerId(),
    playerStatus: "ACTIVE",
    trainerName: "Natan",
    originRegionId: "11111111-1111-4111-8111-111111111111",
    locale: "pt-BR",
    trainerLevel: 7,
    progressionPoints: 1234n,
    onboardingState: "COMPLETE",
    contentReleaseId: "22222222-2222-4222-8222-222222222222",
    rulesetId: "33333333-3333-4333-8333-333333333333",
    starterPokemonInstanceId: createPokemonInstanceId(),
    team: [
      {
        pokemonInstanceId: createPokemonInstanceId(),
        formId: "44444444-4444-4444-8444-444444444444",
        level: 12,
        currentHp: 31,
        slotNo: 1,
      },
    ],
    ...overrides,
  };
}

function repositoryFor(input: {
  resolvedPlayerId?: PlayerProfileView["playerId"] | null;
  profile?: PlayerProfileView | null;
  onIdentity?: (value: unknown) => void;
}): PlayerOnboardingRepository {
  const transaction = {
    findPlayerByIdentity: async (value: unknown) => {
      input.onIdentity?.(value);
      return input.resolvedPlayerId ?? input.profile?.playerId ?? null;
    },
    loadProfileView: async () => input.profile ?? null,
  } as unknown as PlayerOnboardingTransaction;

  return {
    read: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) => work(transaction),
    transaction: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) =>
      work(transaction),
  };
}

describe("PlayerPortalReadService", () => {
  it("resolves the authenticated identity and returns only that player's portal view", async () => {
    const profile = profileView();
    let resolvedIdentity: unknown;
    const service = new PlayerPortalReadService(
      repositoryFor({
        profile,
        onIdentity: (value) => {
          resolvedIdentity = value;
        },
      }),
    );

    const result = await service.getSelf(identity);

    expect(resolvedIdentity).toEqual(identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.playerId).toBe(profile.playerId);
    expect(result.value.trainerName).toBe("Natan");
    expect(result.value.progressionPoints).toBe("1234");
  });

  it("enriches the portal-only view from the published catalog without changing mechanical team state", async () => {
    const profile = profileView();
    let catalogInput: unknown;
    const service = new PlayerPortalReadService(repositoryFor({ profile }), {
      resolve: async (input: unknown) => {
        catalogInput = input;
        return {
          originRegionName: "Kanto",
          forms: [
            {
              formId: "44444444-4444-4444-8444-444444444444",
              displayName: "Charmander",
              nationalDex: 4,
              typeNames: ["Fire"],
            },
          ],
        };
      },
    });

    const result = await service.getSelf(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(catalogInput).toEqual({
      contentReleaseId: profile.contentReleaseId,
      originRegionId: profile.originRegionId,
      formIds: [profile.team[0]?.formId],
    });
    expect(result.value.originRegionName).toBe("Kanto");
    expect(result.value.team).toEqual([
      {
        ...profile.team[0],
        displayName: "Charmander",
        nationalDex: 4,
        typeNames: ["Fire"],
      },
    ]);
  });

  it("keeps unresolved catalog presentation honest instead of inventing display data", async () => {
    const profile = profileView();
    const service = new PlayerPortalReadService(repositoryFor({ profile }), {
      resolve: async () => ({ originRegionName: null, forms: [] }),
    });

    const result = await service.getSelf(identity);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.originRegionName).toBeNull();
    expect(result.value.team[0]).toEqual({
      ...profile.team[0],
      displayName: null,
      nationalDex: null,
      typeNames: [],
    });
  });

  it("fails closed when the authenticated identity is not linked to a player", async () => {
    const service = new PlayerPortalReadService(
      repositoryFor({ resolvedPlayerId: null, profile: null }),
    );

    const result = await service.getSelf(identity);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Player portal profile unavailable",
      },
    });
  });

  it("fails closed for a non-active player", async () => {
    const profile = profileView({ playerStatus: "SUSPENDED" });
    const service = new PlayerPortalReadService(repositoryFor({ profile }));

    const result = await service.getSelf(identity);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLAYER_INELIGIBLE",
        message: "Player is not eligible for Hub access",
      },
    });
  });

  it("rejects malformed external identity before repository access", async () => {
    let touched = false;
    const service = new PlayerPortalReadService(
      repositoryFor({
        profile: profileView(),
        onIdentity: () => {
          touched = true;
        },
      }),
    );

    const result = await service.getSelf({ provider: "Whats App", externalId: "" });

    expect(touched).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
