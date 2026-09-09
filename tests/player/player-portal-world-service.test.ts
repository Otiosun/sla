import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalWorldService } from "../../src/modules/player-portal/world-service.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

describe("PlayerPortalWorldService", () => {
  it("resolves the authenticated identity and maps WorldLocationView to a portal-safe JSON view", async () => {
    const playerId = createPlayerId();
    let requestedPlayerId = "";
    const service = new PlayerPortalWorldService(
      {
        read: async (work: (transaction: unknown) => Promise<unknown>) =>
          work({
            findPlayerByIdentity: async (requestedIdentity: ExternalIdentity) => {
              expect(requestedIdentity).toEqual(identity);
              return playerId;
            },
          }),
      } as never,
      {
        getLocation: async (requestedId: string) => {
          requestedPlayerId = requestedId;
          return ok({
            playerId,
            contentReleaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            areaId: "11111111-1111-4111-8111-111111111111",
            areaSlug: "route-1",
            areaDisplayName: "Route 1",
            regionId: "22222222-2222-4222-8222-222222222222",
            regionSlug: "kanto",
            regionDisplayName: "Kanto",
            safePoint: false,
            revision: 3n,
            enteredAt: new Date("2026-09-09T18:00:00.000Z"),
            requiresRelocation: false,
            relocationAreaId: null,
            connections: [
              {
                connectionId: "33333333-3333-4333-8333-333333333333",
                connectionKey: "route-1:pallet-town",
                destinationAreaId: "44444444-4444-4444-8444-444444444444",
                destinationSlug: "pallet-town",
                destinationDisplayName: "Pallet Town",
                available: true,
                missingUnlockKeys: [],
              },
            ],
          });
        },
      } as never,
    );

    const result = await service.getLocation(identity);

    expect(requestedPlayerId).toBe(playerId);
    expect(result).toEqual(
      ok({
        areaId: "11111111-1111-4111-8111-111111111111",
        areaSlug: "route-1",
        areaDisplayName: "Route 1",
        regionId: "22222222-2222-4222-8222-222222222222",
        regionSlug: "kanto",
        regionDisplayName: "Kanto",
        safePoint: false,
        revision: "3",
        enteredAt: "2026-09-09T18:00:00.000Z",
        requiresRelocation: false,
        relocationAreaId: null,
        connections: [
          {
            connectionId: "33333333-3333-4333-8333-333333333333",
            connectionKey: "route-1:pallet-town",
            destinationAreaId: "44444444-4444-4444-8444-444444444444",
            destinationSlug: "pallet-town",
            destinationDisplayName: "Pallet Town",
            available: true,
            missingUnlockKeys: [],
          },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(JSON.stringify(result.value)).not.toContain("playerId");
    expect(JSON.stringify(result.value)).not.toContain("contentReleaseId");
  });

  it("injects the authenticated player into authoritative travel and maps from/to safely", async () => {
    const playerId = createPlayerId();
    let receivedTravel: unknown = null;
    const service = new PlayerPortalWorldService(
      {
        read: async (work: (transaction: unknown) => Promise<unknown>) =>
          work({ findPlayerByIdentity: async () => playerId }),
      } as never,
      {
        travel: async (input: unknown) => {
          receivedTravel = input;
          const common = {
            playerId,
            contentReleaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            regionId: "22222222-2222-4222-8222-222222222222",
            regionSlug: "kanto",
            regionDisplayName: "Kanto",
            safePoint: false,
            requiresRelocation: false,
            relocationAreaId: null,
            connections: [],
          };
          return ok({
            from: {
              ...common,
              areaId: "11111111-1111-4111-8111-111111111111",
              areaSlug: "route-1",
              areaDisplayName: "Route 1",
              revision: 3n,
              enteredAt: new Date("2026-09-09T18:00:00.000Z"),
            },
            to: {
              ...common,
              areaId: "44444444-4444-4444-8444-444444444444",
              areaSlug: "pallet-town",
              areaDisplayName: "Pallet Town",
              safePoint: true,
              revision: 4n,
              enteredAt: new Date("2026-09-09T18:01:00.000Z"),
            },
            replayed: false,
          });
        },
      } as never,
    );

    const result = await service.travel(identity, {
      destinationAreaId: "44444444-4444-4444-8444-444444444444",
      expectedRevision: "3",
      idempotencyKey: "hub-travel-00000001",
    });

    expect(receivedTravel).toEqual({
      playerId,
      destinationAreaId: "44444444-4444-4444-8444-444444444444",
      expectedRevision: 3n,
      idempotencyKey: "hub-travel-00000001",
    });
    expect(result).toEqual(
      ok({
        from: {
          areaId: "11111111-1111-4111-8111-111111111111",
          areaSlug: "route-1",
          areaDisplayName: "Route 1",
          regionId: "22222222-2222-4222-8222-222222222222",
          regionSlug: "kanto",
          regionDisplayName: "Kanto",
          safePoint: false,
          revision: "3",
          enteredAt: "2026-09-09T18:00:00.000Z",
          requiresRelocation: false,
          relocationAreaId: null,
          connections: [],
        },
        to: {
          areaId: "44444444-4444-4444-8444-444444444444",
          areaSlug: "pallet-town",
          areaDisplayName: "Pallet Town",
          regionId: "22222222-2222-4222-8222-222222222222",
          regionSlug: "kanto",
          regionDisplayName: "Kanto",
          safePoint: true,
          revision: "4",
          enteredAt: "2026-09-09T18:01:00.000Z",
          requiresRelocation: false,
          relocationAreaId: null,
          connections: [],
        },
        replayed: false,
      }),
    );
  });
});
