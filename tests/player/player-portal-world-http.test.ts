import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

describe("PlayerPortalHttpHandler world", () => {
  it("returns the authenticated player's portal-safe current location", async () => {
    let requestedIdentity: ExternalIdentity | null = null;
    const handler = new PlayerPortalHttpHandler({
      tickets: {
        redeem: async () => ok(identity),
      },
      sessions: {
        issue: () =>
          ok({ token: "session-token", expiresAt: new Date("2026-09-10T00:00:00.000Z") }),
        verify: () => ok(identity),
      },
      player: {
        getSelf: async () => ok({} as never),
        getPokemon: async () => ok([]),
      },
      world: {
        getLocation: async (verifiedIdentity: ExternalIdentity) => {
          requestedIdentity = verifiedIdentity;
          return ok({
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
          });
        },
      },
    } as never);

    const response = await handler.handle(
      new Request("https://api.example.test/v1/hub/world/location", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requestedIdentity).toEqual(identity);

    const body = await response.json();
    expect(body).toEqual({
      location: {
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
      },
    });
    expect(JSON.stringify(body)).not.toContain("session-token");
    expect(JSON.stringify(body)).not.toContain("contentReleaseId");
    expect(JSON.stringify(body)).not.toContain("playerId");
  });

  it("travels through the authenticated world boundary without accepting a player id", async () => {
    let requestedIdentity: ExternalIdentity | null = null;
    let requestedTravel: unknown = null;
    const travel = {
      from: { areaId: "route-1", revision: "3" },
      to: { areaId: "pallet-town", revision: "4" },
      replayed: false,
    };
    const handler = new PlayerPortalHttpHandler({
      tickets: { redeem: async () => ok(identity) },
      sessions: {
        issue: () =>
          ok({ token: "session-token", expiresAt: new Date("2026-09-10T00:00:00.000Z") }),
        verify: () => ok(identity),
      },
      player: {
        getSelf: async () => ok({} as never),
        getPokemon: async () => ok([]),
      },
      world: {
        getLocation: async () => ok({} as never),
        travel: async (verifiedIdentity: ExternalIdentity, input: unknown) => {
          requestedIdentity = verifiedIdentity;
          requestedTravel = input;
          return ok(travel);
        },
      },
    } as never);

    const response = await handler.handle(
      new Request("https://api.example.test/v1/hub/world/travel", {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          destinationAreaId: "44444444-4444-4444-8444-444444444444",
          expectedRevision: "3",
          idempotencyKey: "hub-travel-00000001",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requestedIdentity).toEqual(identity);
    expect(requestedTravel).toEqual({
      destinationAreaId: "44444444-4444-4444-8444-444444444444",
      expectedRevision: "3",
      idempotencyKey: "hub-travel-00000001",
    });
    expect(await response.json()).toEqual({ travel });
  });
});
