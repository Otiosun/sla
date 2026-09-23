import { describe, expect, it, vi } from "vitest";
import type { ExternalIdentity } from "../../src/modules/player/contracts.js";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";
import type {
  PlayerPortalSelfView,
  PlayerPortalWorldLocationView,
} from "../../src/modules/player-portal/read-service.js";
import { createPlayerId, createPokemonInstanceId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const identity: ExternalIdentity = {
  provider: "baileys",
  externalId: "5511999999999@s.whatsapp.net",
};

const profile: PlayerPortalSelfView = {
  playerId: createPlayerId(),
  playerStatus: "ACTIVE",
  trainerName: "Natan",
  originRegionId: "11111111-1111-4111-8111-111111111111",
  originRegionName: "Zhoulia",
  locale: "pt-BR",
  trainerLevel: 7,
  progressionPoints: "1234",
  onboardingState: "COMPLETE",
  contentReleaseId: "22222222-2222-4222-8222-222222222222",
  rulesetId: "33333333-3333-4333-8333-333333333333",
  starterPokemonInstanceId: createPokemonInstanceId(),
  profileCustomization: {
    title: null,
    bio: null,
    appearance: null,
    age: null,
    height: null,
    accent: "crimson",
  },
  team: [],
};

const location: PlayerPortalWorldLocationView = {
  areaId: "44444444-4444-4444-8444-444444444444",
  areaSlug: "vila-dos-arrozais",
  areaDisplayName: "Vila dos Arrozais",
  regionId: "55555555-5555-4555-8555-555555555555",
  regionSlug: "zhoulia",
  regionDisplayName: "Zhoulia",
  safePoint: true,
  revision: "3",
  enteredAt: "2026-09-18T20:00:00.000Z",
  requiresRelocation: false,
  relocationAreaId: null,
  connections: [],
};

function handler() {
  const rosterMove = vi.fn(async () => ok(undefined));
  const resolveMoveChoice = vi.fn(async () =>
    ok({
      choiceId: "11111111-1111-4111-8111-111111111111",
      pokemonInstanceId: createPokemonInstanceId(),
      moveId: "22222222-2222-4222-8222-222222222222",
      status: "SKIPPED" as const,
      replacedSlotNo: null,
      replayed: false,
    }),
  );
  const customizationUpdate = vi.fn(async () => ok(profile.profileCustomization));
  const instance = new PlayerPortalHttpHandler({
    tickets: { redeem: async () => ok(identity) },
    sessions: {
      issue: () =>
        ok({
          token: "session-token",
          expiresAt: new Date("2026-09-19T00:00:00.000Z"),
        }),
      verify: () => ok(identity),
    },
    player: {
      getSelf: async () => ok(profile),
      getPokemon: async () => ok([]),
      getPokedex: async () => ok([]),
      getInventory: async () => ok([]),
      getLocation: async () => ok(location),
      getBattle: async () => ok(null),
    },
    roster: { move: rosterMove },
    moveChoices: {
      list: async () => ok({ blockedByBattle: false, choices: [] }),
      resolve: resolveMoveChoice,
    },
    customization: { update: customizationUpdate },
    admin: {
      resolvePrincipal: async () => null,
      capabilitiesFor: async () => [],
    },
  });
  return { instance, rosterMove, resolveMoveChoice, customizationUpdate };
}

describe("PlayerPortalHttpHandler companion boundary", () => {
  it("exchanges a one-shot ticket for a secure HttpOnly cookie", async () => {
    const response = await handler().instance.handle(
      new Request("https://api.example.test/v1/hub/auth/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: "A".repeat(43) }),
      }),
    );

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("__Host-pokemon_hub_session=session-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("exposes profile, inventory, both location routes and read-only battle consultation", async () => {
    for (const [path, key] of [
      ["/v1/hub/player/self", "profile"],
      ["/v1/hub/player/inventory", "inventory"],
      ["/v1/hub/world/location", "location"],
      ["/v1/hub/player/location", "location"],
      ["/v1/hub/player/battle", "battle"],
    ] as const) {
      const response = await handler().instance.handle(
        new Request(`https://api.example.test${path}`, {
          headers: { cookie: "__Host-pokemon_hub_session=session-token" },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty(key);
    }
  });

  it("hides the admin surface from ordinary authenticated players", async () => {
    const response = await handler().instance.handle(
      new Request("https://api.example.test/v1/hub/admin/self", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ admin: null });
  });

  it("allows roster, move learning and cosmetic profile updates without gameplay mutations", async () => {
    const { instance, rosterMove, resolveMoveChoice, customizationUpdate } = handler();

    const response = await instance.handle(
      new Request("https://api.example.test/v1/hub/player/roster", {
        method: "PUT",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pokemonInstanceId: "66666666-6666-4666-8666-666666666666",
          target: { placementKind: "TEAM", boxNo: null, slotNo: 1 },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(rosterMove).toHaveBeenCalledOnce();

    const choices = await instance.handle(
      new Request("https://api.example.test/v1/hub/player/move-choices", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(choices.status).toBe(200);
    expect(await choices.json()).toEqual({ blockedByBattle: false, choices: [] });

    const resolved = await instance.handle(
      new Request("https://api.example.test/v1/hub/player/move-choices/resolve", {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          choiceId: "11111111-1111-4111-8111-111111111111",
          replaceSlotNo: null,
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    expect(resolveMoveChoice).toHaveBeenCalledOnce();

    const profileResponse = await instance.handle(
      new Request("https://api.example.test/v1/hub/player/profile-customization", {
        method: "PUT",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Explorador",
          bio: "Sempre seguindo a próxima trilha.",
          appearance: null,
          age: 29,
          height: "1,94 m",
          accent: "gold",
        }),
      }),
    );
    expect(profileResponse.status).toBe(200);
    expect(customizationUpdate).toHaveBeenCalledOnce();
    expect(await profileResponse.json()).toHaveProperty("profile");

    for (const path of [
      "/v1/hub/world/travel",
      "/v1/hub/encounter/start",
      "/v1/hub/player/battle/action",
      "/v1/hub/capture",
    ]) {
      const blocked = await instance.handle(
        new Request(`https://api.example.test${path}`, {
          method: "POST",
          headers: {
            cookie: "__Host-pokemon_hub_session=session-token",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(blocked.status).toBe(404);
    }
  });
});
