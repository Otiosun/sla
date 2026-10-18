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

function handler(
  options: { admin?: boolean; capabilities?: readonly string[]; principalId?: string; owner?: boolean; premiumRead?: boolean; support?: boolean } = {},
) {
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
  const premiumOrdersList = vi.fn(async () => []);
  const premiumOrderCreate = vi.fn(async () => ({
    kind: "CREATED" as const,
    replayed: false,
    order: {
      id: "99999999-9999-4999-8999-999999999999",
      humanId: "PB-00000001",
      playerId: profile.playerId,
      status: "PENDING" as const,
      currency: "BRL",
      totalCents: 4000,
      revision: "0",
      createdAt: new Date("2026-10-18T04:00:00Z").toISOString(),
      paidAt: null,
      appliedAt: null,
      cancelledAt: null,
      items: [],
    },
  }));
  const premiumEntitlementsList = vi.fn(async () => []);
  const premiumSupportList = vi.fn(async () => []);
  const premiumSupportAppend = vi.fn(async (playerId: string, actorPrincipalId: string, input: {
    eventId: string;
    orderId: string | null;
    kind: "NOTE" | "REVIEW" | "RESOLVED";
    body: string;
  }) => ({
    replayed: false,
    event: {
      id: input.eventId,
      playerId,
      orderId: input.orderId,
      actorPrincipalId,
      kind: input.kind,
      body: input.body,
      createdAt: "2026-10-18T04:00:00.000Z",
    },
  }));
  const adminPlayerSearch = vi.fn(async () => ({ items: [], nextCursor: null }));
  const adminPlayerGet = vi.fn(async () => {
    throw new Error("admin player get not used in this harness");
  });
  const adminRewardCatalogGet = vi.fn(async () => ({
    items: [
      {
        itemId: "12121212-1212-4212-8212-121212121212",
        slug: "great-ball",
        displayName: "Great Ball",
        itemKind: "BALL",
      },
    ],
    currencies: [
      {
        currencyId: "13131313-1313-4313-8313-131313131313",
        slug: "poke-dollar",
        displayName: "Poké Dollar",
        allowsNegative: false,
      },
    ],
  }));
  const adminListOperationDefinitions = vi.fn(() => [
    {
      kind: "MUTATION" as const,
      operationType: "wallet.adjust",
      capabilityKey: "wallet.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT" as const,
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: false,
        requiresConfirmation: false,
        requiredApprovals: 0,
      },
    },
    {
      kind: "MUTATION" as const,
      operationType: "pokemon.create",
      capabilityKey: "pokemon.create",
      riskTier: 3,
      authorizationMode: "SUBJECT" as const,
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: false,
        requiresSimulation: false,
        requiresConfirmation: true,
        requiredApprovals: 0,
      },
    },
  ]);
  const adminPrepareMutation = vi.fn(async () => ({
    operation: {
      id: "88888888-8888-4888-8888-888888888888",
      status: "PENDING_CONFIRMATION",
      result: null,
    },
    replayed: false,
  }));
  const adminSimulateMutation = vi.fn(async () => ({
    id: "88888888-8888-4888-8888-888888888888",
    status: "PENDING_CONFIRMATION",
    result: { simulated: true },
  }));
  const adminConfirmMutation = vi.fn(async () => ({
    id: "88888888-8888-4888-8888-888888888888",
    status: "READY",
    result: null,
  }));
  const adminApproveMutation = vi.fn(async () => ({
    id: "88888888-8888-4888-8888-888888888888",
    status: "READY",
    result: null,
  }));
  const adminApplyMutation = vi.fn(async () => ({
    id: "88888888-8888-4888-8888-888888888888",
    status: "APPLIED",
    result: { balanceAfter: "15" },
  }));
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
      resolvePrincipal: async () =>
        options.admin
          ? { principalId: options.principalId ?? "77777777-7777-4777-8777-777777777777" }
          : null,
      capabilitiesFor: async () =>
        options.admin
          ? [
              "central.view",
              ...(options.capabilities ?? ["player.read"]).filter(
                (capability) => capability !== "central.view",
              ),
            ]
          : [],
    },
    adminPlayers: {
      search: adminPlayerSearch,
      get: adminPlayerGet,
    },
    adminRewardCatalog: {
      get: adminRewardCatalogGet,
    },
    ...(options.owner !== undefined
      ? { adminTeam: { isOwner: async () => options.owner === true } as never }
      : {}),
    ...(options.premiumRead
      ? {
          premiumRead: {
            orders: { listPlayerOrders: premiumOrdersList, createOrder: premiumOrderCreate },
            entitlements: { listPlayerEntitlements: premiumEntitlementsList },
          },
        }
      : {}),
    ...(options.support
      ? { premiumSupport: { list: premiumSupportList, append: premiumSupportAppend } }
      : {}),
    adminMutations: {
      listOperationDefinitions: adminListOperationDefinitions,
      prepareMutation: adminPrepareMutation,
      simulate: adminSimulateMutation,
      confirm: adminConfirmMutation,
      approve: adminApproveMutation,
      apply: adminApplyMutation,
    },
  });
  return {
    instance,
    rosterMove,
    resolveMoveChoice,
    customizationUpdate,
    adminPlayerSearch,
    adminPlayerGet,
    adminRewardCatalogGet,
    premiumOrdersList,
    premiumOrderCreate,
    premiumEntitlementsList,
    premiumSupportList,
    premiumSupportAppend,
    adminListOperationDefinitions,
    adminPrepareMutation,
    adminSimulateMutation,
    adminConfirmMutation,
    adminApproveMutation,
    adminApplyMutation,
  };
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

  it("keeps Player 360 hidden from normal sessions and exposes search to authorized admins", async () => {
    const denied = await handler().instance.handle(
      new Request("https://api.example.test/v1/hub/admin/players?q=Nat&limit=10", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(denied.status).toBe(403);

    const { instance, adminPlayerSearch } = handler({ admin: true });
    const allowed = await instance.handle(
      new Request("https://api.example.test/v1/hub/admin/players?q=Nat&limit=10", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ players: [], nextCursor: null });
    expect(adminPlayerSearch).toHaveBeenCalledWith({
      principalId: "77777777-7777-4777-8777-777777777777",
      includeSensitive: false,
      trainerNamePrefix: "Nat",
      limit: 10,
    });
  });

  it("keeps the reward catalog admin-only and returns only the service-approved view", async () => {
    const denied = await handler().instance.handle(
      new Request("https://api.example.test/v1/hub/admin/reward-catalog", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(denied.status).toBe(403);

    const { instance, adminRewardCatalogGet } = handler({
      admin: true,
      capabilities: ["inventory.read", "economy.read"],
    });
    const allowed = await instance.handle(
      new Request("https://api.example.test/v1/hub/admin/reward-catalog", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      items: [
        {
          itemId: "12121212-1212-4212-8212-121212121212",
          slug: "great-ball",
          displayName: "Great Ball",
          itemKind: "BALL",
        },
      ],
      currencies: [
        {
          currencyId: "13131313-1313-4313-8313-131313131313",
          slug: "poke-dollar",
          displayName: "Poké Dollar",
          allowsNegative: false,
        },
      ],
      species: [],
      forms: [],
      abilities: [],
      natures: [],
      effects: [],
      releases: [],
    });
    expect(adminRewardCatalogGet).toHaveBeenCalledWith("77777777-7777-4777-8777-777777777777", {
      items: true,
      currencies: true,
      species: false,
      forms: false,
      effects: false,
      releases: false,
    });
  });

  it("lists only registered admin operations granted to the current principal", async () => {
    const denied = await handler().instance.handle(
      new Request("https://api.example.test/v1/hub/admin/operations", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(denied.status).toBe(403);

    const { instance, adminListOperationDefinitions } = handler({
      admin: true,
      capabilities: ["pokemon.create"],
    });
    const allowed = await instance.handle(
      new Request("https://api.example.test/v1/hub/admin/operations", {
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      operations: [
        {
          kind: "MUTATION",
          operationType: "pokemon.create",
          capabilityKey: "pokemon.create",
          riskTier: 3,
          authorizationMode: "SUBJECT",
          policy: {
            version: 1,
            requiresReason: true,
            requiresExpectedRevision: false,
            requiresSimulation: false,
            requiresConfirmation: true,
            requiredApprovals: 0,
          },
        },
      ],
    });
    expect(adminListOperationDefinitions).toHaveBeenCalledOnce();
  });

  it("drives audited admin operations through prepare, confirm, approve and apply without accepting actor mass-assignment", async () => {
    const requestId = "99999999-9999-4999-8999-999999999999";
    const operationId = "88888888-8888-4888-8888-888888888888";
    const {
      instance,
      adminPrepareMutation,
      adminConfirmMutation,
      adminApproveMutation,
      adminApplyMutation,
    } = handler({ admin: true, capabilities: ["pokemon.create"] });

    const prepared = await instance.handle(
      new Request("https://api.example.test/v1/hub/admin/operations", {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId,
          operationType: "pokemon.create",
          input: {
            playerId: "22222222-2222-4222-8222-222222222222",
            speciesId: "33333333-3333-4333-8333-333333333333",
          },
          reason: "Restore audited Pokémon reward",
        }),
      }),
    );

    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toEqual({
      operationId,
      status: "PENDING_CONFIRMATION",
      replayed: false,
      result: null,
    });
    expect(adminPrepareMutation).toHaveBeenCalledWith({
      principalId: "77777777-7777-4777-8777-777777777777",
      operationType: "pokemon.create",
      input: {
        playerId: "22222222-2222-4222-8222-222222222222",
        speciesId: "33333333-3333-4333-8333-333333333333",
      },
      reason: "Restore audited Pokémon reward",
      idempotencyKey: `hub-admin-operation:${requestId}`,
      correlationId: requestId,
    });

    const confirmed = await instance.handle(
      new Request(`https://api.example.test/v1/hub/admin/operations/${operationId}/confirm`, {
        method: "POST",
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(confirmed.status).toBe(200);
    expect(adminConfirmMutation).toHaveBeenCalledWith(
      operationId,
      "77777777-7777-4777-8777-777777777777",
    );

    const { instance: approverInstance, adminApproveMutation: secondAdminApproveMutation } =
      handler({
        admin: true,
        capabilities: ["pokemon.create"],
        principalId: "66666666-6666-4666-8666-666666666666",
      });
    const approved = await approverInstance.handle(
      new Request(`https://api.example.test/v1/hub/admin/operations/${operationId}/approve`, {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Second-admin review" }),
      }),
    );
    expect(approved.status).toBe(200);
    expect(secondAdminApproveMutation).toHaveBeenCalledWith(
      operationId,
      "66666666-6666-4666-8666-666666666666",
      "Second-admin review",
    );
    expect(adminApproveMutation).not.toHaveBeenCalled();

    const applied = await instance.handle(
      new Request(`https://api.example.test/v1/hub/admin/operations/${operationId}/apply`, {
        method: "POST",
        headers: { cookie: "__Host-pokemon_hub_session=session-token" },
      }),
    );
    expect(applied.status).toBe(200);
    expect(adminApplyMutation).toHaveBeenCalledWith(
      operationId,
      "77777777-7777-4777-8777-777777777777",
    );

    const rejectedMassAssignment = await instance.handle(
      new Request("https://api.example.test/v1/hub/admin/operations", {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId,
          operationType: "pokemon.create",
          input: {},
          principalId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
    expect(rejectedMassAssignment.status).toBe(400);
    expect(adminPrepareMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps audited player adjustments admin-only and binds the target player to the route", async () => {
    const targetPlayerId = "22222222-2222-4222-8222-222222222222";
    const requestId = "99999999-9999-4999-8999-999999999999";
    const body = {
      requestId,
      kind: "INVENTORY",
      itemId: "33333333-3333-4333-8333-333333333333",
      delta: "5",
      reason: "Restore event reward",
    };

    const denied = await handler().instance.handle(
      new Request(`https://api.example.test/v1/hub/admin/players/${targetPlayerId}/adjustments`, {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(denied.status).toBe(403);

    const { instance, adminPrepareMutation, adminApplyMutation } = handler({ admin: true });
    const allowed = await instance.handle(
      new Request(`https://api.example.test/v1/hub/admin/players/${targetPlayerId}/adjustments`, {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      operationId: "88888888-8888-4888-8888-888888888888",
      status: "APPLIED",
      replayed: false,
      result: { balanceAfter: "15" },
    });
    expect(adminPrepareMutation).toHaveBeenCalledWith({
      principalId: "77777777-7777-4777-8777-777777777777",
      operationType: "inventory.adjust",
      input: {
        playerId: targetPlayerId,
        itemId: "33333333-3333-4333-8333-333333333333",
        delta: "5",
      },
      reason: "Restore event reward",
      idempotencyKey: `hub-player-adjust:${requestId}`,
      correlationId: requestId,
    });
    expect(adminApplyMutation).toHaveBeenCalledWith(
      "88888888-8888-4888-8888-888888888888",
      "77777777-7777-4777-8777-777777777777",
    );

    const massAssignment = await instance.handle(
      new Request(`https://api.example.test/v1/hub/admin/players/${targetPlayerId}/adjustments`, {
        method: "POST",
        headers: {
          cookie: "__Host-pokemon_hub_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          playerId: "44444444-4444-4444-8444-444444444444",
        }),
      }),
    );
    expect(massAssignment.status).toBe(400);
    expect(adminPrepareMutation).toHaveBeenCalledTimes(1);
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

describe("Premium owner-only read boundary", () => {
  const playerId = "11111111-1111-4111-8111-111111111111";
  const uri = (resource: "orders" | "entitlements") =>
    `https://example.test/v1/hub/admin/premium/players/${playerId}/${resource}`;

  it("denies unauthenticated and non-owner sessions without querying premium data", async () => {
    for (const options of [
      { admin: false, owner: false, premiumRead: true },
      { admin: true, owner: false, premiumRead: true },
    ]) {
      const setup = handler(options);
      const result = await setup.instance.handle(new Request(uri("orders"), { headers: { cookie: "__Host-pokemon_hub_session=session-token" } }));
      expect(result.status).toBe(403);
      expect(setup.premiumOrdersList).not.toHaveBeenCalled();
    }
  });

  it("returns owner-only order and entitlement lists through the authenticated session", async () => {
    const setup = handler({ admin: true, owner: true, premiumRead: true });
    const orders = await setup.instance.handle(new Request(uri("orders"), { headers: { cookie: "__Host-pokemon_hub_session=session-token" } }));
    const entitlements = await setup.instance.handle(new Request(uri("entitlements"), { headers: { cookie: "__Host-pokemon_hub_session=session-token" } }));
    expect(orders.status).toBe(200);
    expect(entitlements.status).toBe(200);
    expect(await orders.json()).toEqual({ orders: [] });
    expect(await entitlements.json()).toEqual({ entitlements: [] });
    expect(setup.premiumOrdersList).toHaveBeenCalledExactlyOnceWith(playerId);
    expect(setup.premiumEntitlementsList).toHaveBeenCalledExactlyOnceWith(playerId);
  });

  it("rejects requests that omit the authenticated session cookie", async () => {
    const setup = handler({ admin: true, owner: true, premiumRead: true });
    const response = await setup.instance.handle(new Request(uri("orders")));
    expect(response.status).toBe(401);
    expect(setup.premiumOrdersList).not.toHaveBeenCalled();
  });

  it("does not expose writes or an unconfigured premium service", async () => {
    const setup = handler({ admin: true, owner: true });
    expect((await setup.instance.handle(new Request(uri("orders"), { headers: { cookie: "__Host-pokemon_hub_session=session-token" } }))).status).toBe(503);
    expect((await setup.instance.handle(new Request(uri("orders"), { method: "POST" }))).status).toBe(404);
    expect((await setup.instance.handle(new Request(
      "https://example.test/v1/hub/admin/premium/players/not-a-uuid/orders",
    ))).status).toBe(404);
  });
});

describe("Authenticated player Premium pending orders", () => {
  const endpoint = "https://example.test/v1/hub/player/premium/orders";
  const requestId = "99999999-9999-4999-8999-999999999999";
  const validPayload = { requestId, items: [{ sku: "2XP", quantity: 2 }] };
  const issue = (body: unknown, session = true) =>
    new Request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: "__Host-pokemon_hub_session=session-token" } : {}),
      },
      body: JSON.stringify(body),
    });

  it("creates an unpaid order bound to the authenticated player, never client prices", async () => {
    const setup = handler({ premiumRead: true });
    const response = await setup.instance.handle(issue({
      ...validPayload,
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      order: { humanId: "PB-00000001", status: "PENDING", totalCents: 4000 },
      paymentStatus: "PENDING",
    });
    expect(setup.premiumOrderCreate).toHaveBeenCalledWith({
      playerId: profile.playerId,
      items: [{ sku: "2XP", quantity: 2 }],
      idempotencyScope: `hub-player-premium:${profile.playerId}`,
      idempotencyKey: requestId,
      metadata: { channel: "HUB_SITE", payment: "MANUAL_PENDING" },
      correlationId: requestId,
    });
  });

  it("rejects spoofed playerId, prices, invalid products and unauthenticated requests", async () => {
    const setup = handler({ premiumRead: true });
    expect((await setup.instance.handle(issue(validPayload, false))).status).toBe(401);
    for (const invalid of [
      { ...validPayload, playerId: "11111111-1111-4111-8111-111111111111" },
      { ...validPayload, amountCents: 1 },
      { ...validPayload, items: [{ sku: "LUCK", quantity: 1 }] },
      { ...validPayload, items: [{ sku: "2XP", quantity: 53 }] },
      { ...validPayload, items: [{ sku: "2XP", quantity: 1 }, { sku: "2XP", quantity: 1 }] },
    ]) {
      const response = await setup.instance.handle(issue(invalid));
      expect(response.status).toBe(400);
    }
    expect(setup.premiumOrderCreate).not.toHaveBeenCalled();
  });

  it("returns 503 without service and rejects HTTP GET/DELETE", async () => {
    const setup = handler();
    expect((await setup.instance.handle(issue(validPayload))).status).toBe(503);
    for (const method of ["GET", "DELETE"]) {
      expect((await setup.instance.handle(new Request(endpoint, { method }))).status).toBe(404);
    }
  });
});

describe("Owner-only Premium support ledger", () => {
  const playerId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const url = `https://api.example.test/v1/hub/admin/premium/players/${playerId}/support`;
  const headers = { cookie: "__Host-pokemon_hub_session=session-token" };

  it("rejects anonymous and non-owner access before any support reads", async () => {
    const anonymous = handler({ admin: true, owner: true, support: true });
    expect((await anonymous.instance.handle(new Request(url))).status).toBe(401);
    expect(anonymous.premiumSupportList).not.toHaveBeenCalled();

    for (const config of [
      { admin: false, owner: false, support: true },
      { admin: true, owner: false, support: true },
    ]) {
      const actor = handler(config);
      expect((await actor.instance.handle(new Request(url, { headers }))).status).toBe(403);
      expect(actor.premiumSupportList).not.toHaveBeenCalled();
    }
  });

  it("lists support events for a selected player without reading other players", async () => {
    const actor = handler({ admin: true, owner: true, support: true });
    const result = await actor.instance.handle(new Request(url, { headers }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ events: [] });
    expect(actor.premiumSupportList).toHaveBeenCalledExactlyOnceWith(playerId);
  });

  it("records only owner-authored support notes, never payment or grants", async () => {
    const actor = handler({ admin: true, owner: true, support: true });
    const payload = {
      eventId,
      orderId: null,
      kind: "REVIEW",
      body: "Solicitar verificação manual no atendimento.",
    };
    const result = await actor.instance.handle(new Request(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    expect(result.status).toBe(201);
    expect((await result.json()).event).toMatchObject({
      id: eventId,
      playerId,
      kind: "REVIEW",
    });
    expect(actor.premiumSupportAppend).toHaveBeenCalledWith(
      playerId,
      "77777777-7777-4777-8777-777777777777",
      payload,
    );
  });

  it("rejects extra client actor fields, malformed notes and disabled support service", async () => {
    const actor = handler({ admin: true, owner: true, support: true });
    for (const payload of [
      { eventId, orderId: null, kind: "PAID", body: "Pagamento confirmado fora do suporte." },
      { eventId, orderId: null, kind: "NOTE", body: "Curto" },
      {
        eventId, orderId: null, kind: "NOTE", body: "Aguardando mais informações.",
        actorPrincipalId: "33333333-3333-4333-8333-333333333333",
      },
    ]) {
      const response = await actor.instance.handle(new Request(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }));
      expect(response.status).toBe(400);
    }
    expect(actor.premiumSupportAppend).not.toHaveBeenCalled();
    const unconfigured = handler({ admin: true, owner: true });
    expect((await unconfigured.instance.handle(new Request(url, { headers }))).status).toBe(503);
  });
});
