import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

describe("PlayerPortalHttpHandler Pokedex", () => {
  it("returns authenticated Pokedex progress without exposing session material", async () => {
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
        getPokedex: async () =>
          ok([
            {
              nationalDex: 4,
              seenCount: "3",
              caughtCount: "1",
              firstSeenAt: "2026-09-01T10:00:00.000Z",
              lastSeenAt: "2026-09-08T12:30:00.000Z",
              firstCaughtAt: "2026-09-02T11:00:00.000Z",
              lastCaughtAt: "2026-09-02T11:00:00.000Z",
            },
          ]),
      },
    } as never);

    const response = await handler.handle(
      new Request("https://api.example.test/v1/hub/player/pokedex", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      pokedex: [
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
    expect(JSON.stringify(body)).not.toContain("session-token");
  });
});
