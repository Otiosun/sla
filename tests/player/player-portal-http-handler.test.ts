import { describe, expect, it } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import type { PlayerPortalSelfView } from "../../src/modules/player-portal/read-service.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "whatsapp",
  externalId: "5511999999999",
};

const profile: PlayerPortalSelfView = {
  playerId: createPlayerId(),
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: "11111111-1111-4111-8111-111111111111",
  originRegionName: "Kanto",
  locale: "pt-BR",
  trainerLevel: 7,
  progressionPoints: "1234",
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
      displayName: "Charmander",
      nationalDex: 4,
      typeNames: ["Fire"],
    },
  ],
};

const sessionExpiresAt = new Date("2026-09-10T00:00:00.000Z");

function handler(
  input: {
    selfResult?: Result<PlayerPortalSelfView>;
    verifiedIdentity?: ExternalIdentity | null;
    onVerify?: (token: string) => void;
  } = {},
): PlayerPortalHttpHandler {
  return new PlayerPortalHttpHandler({
    tickets: {
      redeem: async () => ok(identity),
    },
    sessions: {
      issue: () => ok({ token: "session-token", expiresAt: sessionExpiresAt }),
      verify: (token) => {
        input.onVerify?.(token);
        return input.verifiedIdentity === null
          ? err(appError("NOT_FOUND", "Hub session unavailable"))
          : ok(input.verifiedIdentity ?? identity);
      },
    },
    player: {
      getSelf: async () => input.selfResult ?? ok(profile),
      getPokemon: async () => ok([]),
      getPokedex: async () => ok([]),
    },
  });
}

describe("PlayerPortalHttpHandler", () => {
  it("exchanges a one-shot ticket for an HttpOnly session cookie and real profile", async () => {
    const response = await handler().handle(
      new Request("https://api.example.test/v1/hub/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: "A".repeat(43) }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("__Host-pokemon_hub_session=session-token");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=43200");
    const body = await response.json();
    expect(body).toEqual({
      profile,
      sessionExpiresAt: "2026-09-10T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("session-token");
  });

  it("does not issue a session when the redeemed player is ineligible", async () => {
    const response = await handler({
      selfResult: err(appError("PLAYER_INELIGIBLE", "Player is not eligible for Hub access")),
    }).handle(
      new Request("https://api.example.test/v1/hub/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: "A".repeat(43) }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reads the authenticated player's self profile from the session cookie", async () => {
    let verifiedToken = "";
    const response = await handler({
      onVerify: (token) => {
        verifiedToken = token;
      },
    }).handle(
      new Request("https://api.example.test/v1/hub/player/self", {
        headers: { cookie: "theme=dark; __Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(verifiedToken).toBe("session-token");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ profile });
  });

  it("reads only the authenticated player's Pokedex progress from the session cookie", async () => {
    const response = await handler().handle(
      new Request("https://api.example.test/v1/hub/player/pokedex", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ pokedex: [] });
  });

  it("rejects self reads without a valid session cookie", async () => {
    const response = await handler({ verifiedIdentity: null }).handle(
      new Request("https://api.example.test/v1/hub/player/self"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
