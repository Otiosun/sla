import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

describe("PlayerPortalHttpHandler owned Pokemon", () => {
  it("returns the authenticated player's owned Pokemon without exposing session material", async () => {
    const pokemonInstanceId = createPokemonInstanceId();
    const handler = new PlayerPortalHttpHandler({
      tickets: {
        redeem: async () => ok(identity),
      },
      sessions: {
        issue: () => ok({ token: "session-token", expiresAt: new Date("2026-09-10T00:00:00.000Z") }),
        verify: () => ok(identity),
      },
      player: {
        getSelf: async () => ok({} as never),
        getPokemon: async () =>
          ok([
            {
              pokemonInstanceId,
              formId: "44444444-4444-4444-8444-444444444444",
              displayName: "Charmander",
              nationalDex: 4,
              typeNames: ["Fire"],
              nickname: "Brasa",
              level: 12,
              currentHp: 31,
              gender: "M",
              shiny: false,
              placementKind: "TEAM",
              boxNo: null,
              slotNo: 1,
            },
          ]),
      },
    } as never);

    const response = await handler.handle(
      new Request("https://api.example.test/v1/hub/player/pokemon", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      pokemon: [
        {
          pokemonInstanceId,
          formId: "44444444-4444-4444-8444-444444444444",
          displayName: "Charmander",
          nationalDex: 4,
          typeNames: ["Fire"],
          nickname: "Brasa",
          level: 12,
          currentHp: 31,
          gender: "M",
          shiny: false,
          placementKind: "TEAM",
          boxNo: null,
          slotNo: 1,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("session-token");
  });
});
