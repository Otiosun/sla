import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import type {
  PlayerOnboardingRepository,
  PlayerOnboardingTransaction,
} from "../../src/modules/player/ports.js";
import {
  PlayerPortalLocationReadService,
  type PlayerPortalWorldLocationReader,
} from "../../src/modules/player-portal/location-read-service.js";
import type { WorldLocationView } from "../../src/modules/world/contracts.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

function repositoryFor(playerId: ReturnType<typeof createPlayerId> | null): PlayerOnboardingRepository {
  const transaction = {
    findPlayerByIdentity: async () => playerId,
  } as unknown as PlayerOnboardingTransaction;

  return {
    read: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) => work(transaction),
    transaction: async <T>(work: (tx: PlayerOnboardingTransaction) => Promise<T>) =>
      work(transaction),
  };
}

function worldFor(location: WorldLocationView): PlayerPortalWorldLocationReader {
  return {
    getLocation: async () => ok(location),
  };
}

describe("PlayerPortalLocationReadService", () => {
  it("projects only read-only location fields for the authenticated player", async () => {
    const playerId = createPlayerId();
    const enteredAt = new Date("2026-09-10T00:00:00.000Z");
    const location: WorldLocationView = {
      playerId,
      contentReleaseId: "11111111-1111-4111-8111-111111111111",
      areaId: "22222222-2222-4222-8222-222222222222",
      areaSlug: "vila-dos-arrozais",
      areaDisplayName: "Vila dos Arrozais",
      regionId: "33333333-3333-4333-8333-333333333333",
      regionSlug: "zhoulia",
      regionDisplayName: "Zhoulia",
      safePoint: true,
      revision: 7n,
      enteredAt,
      requiresRelocation: false,
      relocationAreaId: null,
      connections: [
        {
          connectionId: "44444444-4444-4444-8444-444444444444",
          connectionKey: "road-east",
          destinationAreaId: "55555555-5555-4555-8555-555555555555",
          destinationSlug: "estrada-leste",
          destinationDisplayName: "Estrada Leste",
          available: true,
          missingUnlockKeys: [],
        },
      ],
    };

    const service = new PlayerPortalLocationReadService(
      repositoryFor(playerId),
      worldFor(location),
    );

    await expect(service.getLocation(identity)).resolves.toEqual({
      ok: true,
      value: {
        areaId: location.areaId,
        areaSlug: "vila-dos-arrozais",
        areaDisplayName: "Vila dos Arrozais",
        regionId: location.regionId,
        regionSlug: "zhoulia",
        regionDisplayName: "Zhoulia",
        safePoint: true,
        enteredAt: enteredAt.toISOString(),
      },
    });
  });

  it("fails closed when the authenticated identity has no linked player", async () => {
    const world: PlayerPortalWorldLocationReader = {
      getLocation: async () => {
        throw new Error("world should not be touched");
      },
    };
    const service = new PlayerPortalLocationReadService(repositoryFor(null), world);

    await expect(service.getLocation(identity)).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Player portal profile unavailable",
      },
    });
  });

  it("preserves authoritative world errors without inventing a location", async () => {
    const playerId = createPlayerId();
    const world: PlayerPortalWorldLocationReader = {
      getLocation: async () => err(appError("NOT_FOUND", "Player location is not initialized")),
    };
    const service = new PlayerPortalLocationReadService(repositoryFor(playerId), world);

    await expect(service.getLocation(identity)).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Player location is not initialized",
      },
    });
  });
});
