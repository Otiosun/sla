import { describe, expect, it, vi } from "vitest";
import type { PlayerProfileView } from "../../src/modules/player/contracts.js";
import { PlayerPortalRosterService } from "../../src/modules/player-portal/roster-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const playerId = createPlayerId();
const pokemonInstanceId = createPokemonInstanceId();
const identity = { provider: "baileys", externalId: "player@test" } as const;

const profile: PlayerProfileView = {
  playerId,
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: null,
  locale: "pt-BR",
  trainerLevel: 1,
  progressionPoints: 0n,
  onboardingState: "COMPLETE",
  contentReleaseId: "22222222-2222-4222-8222-222222222222",
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: pokemonInstanceId,
  team: [],
};

describe("PlayerPortalRosterService", () => {
  it("delegates Team/Box organization to the canonical Pokemon PC storage owner", async () => {
    const move = vi.fn(async () =>
      ok({
        kind: "APPLIED" as const,
        pokemonInstanceId,
        fromPlacementKind: "BOX" as const,
        fromBoxNo: 1,
        fromSlotNo: 1,
        toPlacementKind: "TEAM" as const,
        toBoxNo: null,
        toSlotNo: 2,
        swappedPokemonInstanceId: null,
      }),
    );
    const service = new PlayerPortalRosterService({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      profiles: { getProfile: async () => ok(profile) },
      storage: { move },
    });

    const result = await service.move(identity, {
      pokemonInstanceId,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(move).toHaveBeenCalledWith({
      playerId,
      pokemonInstanceId,
      target: { placementKind: "TEAM", boxNo: null, slotNo: 2 },
    });
  });

  it("rejects invalid box capacity before reaching storage", async () => {
    const move = vi.fn();
    const service = new PlayerPortalRosterService({
      players: {
        resolvePlayer: async () => ok({ playerId, state: "COMPLETE", created: false }),
      },
      profiles: { getProfile: async () => ok(profile) },
      storage: { move },
    });

    const result = await service.move(identity, {
      pokemonInstanceId,
      target: { placementKind: "BOX", boxNo: 1, slotNo: 31 },
    });

    expect(result.ok).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });
});
