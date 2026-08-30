import { describe, expect, it } from "vitest";
import { AdminError } from "../../src/modules/admin/errors.js";
import type { Player360View } from "../../src/modules/admin/player360-contracts.js";
import type {
  Player360ReadRepository,
  Player360SearchQuery,
} from "../../src/modules/admin/player360-ports.js";
import { Player360Service } from "../../src/modules/admin/player360-service.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";

class FakeRepository implements Player360ReadRepository {
  public lastSearch: Player360SearchQuery | null = null;
  public getView: Player360View | null = null;

  public async getPlayer360(): Promise<Player360View | null> {
    return this.getView;
  }

  public async searchPlayers(query: Player360SearchQuery) {
    this.lastSearch = query;
    return {
      hasMore: true,
      items: [
        {
          playerId,
          status: "ACTIVE" as const,
          trainerName: "Red",
          originRegionId: null,
          trainerLevel: 1,
          insigniaPoints: "0",
          areaId: null,
          activeEncounterId: null,
          activeEncounterStatus: null,
          activeBattleId: null,
          activeBattleStatus: null,
          identities: [
            {
              provider: "WHATSAPP",
              externalId: "5511999999999",
              status: "ACTIVE" as const,
              createdAt: "2026-01-02T03:04:05.000Z",
              revokedAt: null,
            },
          ],
          createdAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    };
  }
}

function harness() {
  const operations: string[] = [];
  const authorizer = {
    async authorizeRead(request: unknown) {
      const operationType = (request as { operationType: string }).operationType;
      operations.push(operationType);
      return { type: "TEST", id: null };
    },
  };
  const repository = new FakeRepository();
  const service = new Player360Service(authorizer, repository);
  return { operations, repository, service };
}

describe("Player360Service", () => {
  it("rejects unknown get fields before authorization", async () => {
    const { operations, service } = harness();
    await expect(
      service.get({ principalId, playerId, includeSensitive: false, status: "ACTIVE" }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(operations).toEqual([]);
  });

  it("requires the dedicated sensitive capability before a sensitive read", async () => {
    const { operations, service } = harness();
    await expect(
      service.get({ principalId, playerId, includeSensitive: true }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(operations).toEqual(["player.read", "player.read_sensitive"]);
  });

  it("redacts sensitive get fields even if the repository leaks them", async () => {
    const { repository, service } = harness();
    repository.getView = {
      profile: {
        trainerName: "Red",
        originRegionId: null,
        locale: "pt-BR",
        metadata: { privateNote: "must-not-leak" },
        revision: "1",
      },
      identities: [
        {
          provider: "WHATSAPP",
          externalId: "5511999999999",
          status: "ACTIVE",
          createdAt: "2026-01-02T03:04:05.000Z",
          revokedAt: null,
        },
      ],
    } as unknown as Player360View;

    const result = await service.get({ principalId, playerId, includeSensitive: false });

    expect(result.profile.metadata).toBeNull();
    expect(result.identities[0]?.externalId).toBeNull();
  });

  it("requires identity provider and external id together", async () => {
    const { operations, service } = harness();
    await expect(
      service.search({ principalId, identityProvider: "WHATSAPP", includeSensitive: true }),
    ).rejects.toBeInstanceOf(AdminError);
    expect(operations).toEqual([]);
  });

  it("redacts external identities from ordinary search even if the repository leaks them", async () => {
    const { service } = harness();

    const result = await service.search({ principalId, limit: 1, includeSensitive: false });

    expect(result.items[0]?.identities[0]?.externalId).toBeNull();
  });

  it("round-trips an opaque stable cursor without exposing raw SQL controls", async () => {
    const { operations, repository, service } = harness();
    const first = await service.search({ principalId, trainerNamePrefix: "Re", limit: 1 });
    expect(operations).toEqual(["player.search"]);
    expect(first.nextCursor).not.toBeNull();

    await service.search({
      principalId,
      trainerNamePrefix: "Re",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(repository.lastSearch?.cursor).toEqual({
      createdAt: "2026-01-02T03:04:05.000Z",
      playerId,
    });
  });

  it("rejects malformed cursors", async () => {
    const { service } = harness();
    await expect(
      service.search({ principalId, cursor: "not-a-valid-cursor" }),
    ).rejects.toBeInstanceOf(AdminError);
  });
});
