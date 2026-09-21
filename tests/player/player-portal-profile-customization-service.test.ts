import { describe, expect, it, vi } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import {
  PlayerPortalProfileCustomizationService,
  type PlayerPortalProfileCustomization,
} from "../../src/modules/player-portal/profile-customization-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const identity = { provider: "baileys", externalId: "player@test" } as const;

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: "11111111-1111-4111-8111-111111111111",
  locale: "pt-BR",
  trainerLevel: 3,
  progressionPoints: 240n,
  onboardingState: "COMPLETE",
  contentReleaseId: "22222222-2222-4222-8222-222222222222",
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: null,
  team: [],
};

function createService(currentProfile: PlayerProfileView = profile) {
  const update = vi.fn(async () => true);
  const service = new PlayerPortalProfileCustomizationService({
    players: {
      resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
    },
    profiles: {
      getProfile: async () => ok(currentProfile),
    },
    repository: {
      read: async () => ({
        title: null,
        bio: null,
        appearance: null,
        age: null,
        height: null,
        accent: "teal",
      }),
      update,
    },
  });
  return { service, update };
}

const validCustomization: PlayerPortalProfileCustomization = {
  title: "Explorador",
  bio: "Sempre seguindo a próxima trilha.",
  appearance: "Casaco escuro e mochila de campo.",
  age: 29,
  height: "1,94 m",
  accent: "gold",
};

describe("PlayerPortalProfileCustomizationService", () => {
  it("validates, normalizes and persists only cosmetic profile fields", async () => {
    const { service, update } = createService();

    const result = await service.update(identity, {
      ...validCustomization,
      title: "  Explorador  ",
    });

    expect(result).toEqual({
      ok: true,
      value: { ...validCustomization, title: "Explorador" },
    });
    expect(update).toHaveBeenCalledWith(playerId, {
      ...validCustomization,
      title: "Explorador",
    });
  });

  it("rejects attempts to mutate authoritative trainer identity through this surface", async () => {
    const { service, update } = createService();

    const result = await service.update(identity, {
      ...validCustomization,
      trainerName: "Outro nome",
    });

    expect(result.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps profile customization unavailable until onboarding is complete", async () => {
    const { service, update } = createService({
      ...profile,
      onboardingState: "PROFILE_CREATED",
    });

    const result = await service.update(identity, validCustomization);

    expect(result.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
