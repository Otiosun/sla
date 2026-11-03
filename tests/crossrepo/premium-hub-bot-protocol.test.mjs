import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PlayerPortalHttpHandler } from "../../dist/src/modules/player-portal/http-handler.js";

const EXPECTED_HUB_COMMIT = "b997f1e6d2c5d5effced6e396ceca8607b8d34db";
const UUID = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const SESSION_COOKIE = "__Host-pokemon_hub_session=synthetic-test-token";
const IDENTITY = { provider: "baileys", externalId: "5511999999999@s.whatsapp.net" };

assert.equal(process.env.CI, "true", "Cross-repo proof must run in isolated CI only");
assert.equal(process.env.APP_ENV, "test");
assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.WHATSAPP_ENABLED, "false");

const hubRoot = resolve(process.env.HUB_PREMIUM_CHECKOUT ?? "__hub_contract");
const sha = execFileSync("git", ["-C", hubRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(sha, EXPECTED_HUB_COMMIT, "Hub PR #132 tree changed without reviewing integration");

const { resolvePremiumStageAdminRoute, resolvePremiumStagePlayerRoute } = await import(
  pathToFileURL(join(hubRoot, "src/player-api/premiumStagingRoutes.ts")).href
);
const { resolvePremiumStagingApiBaseUrl } = await import(
  pathToFileURL(join(hubRoot, "src/player-api/premiumStagingBoundary.ts")).href
);

function endpoint(path) {
  return new URL(path, "https://hub-review.invalid");
}

const CORPUS = [
  [
    "GET",
    "/api/hub/admin/premium/delivery/cases/catalog",
    "/v1/hub/admin/premium/delivery/cases/catalog",
  ],
  [
    "GET",
    `/api/hub/admin/premium/delivery/cases?playerId=${UUID}`,
    `/v1/hub/admin/premium/delivery/cases?playerId=${UUID}`,
  ],
  ["POST", "/api/hub/admin/premium/delivery/cases", "/v1/hub/admin/premium/delivery/cases"],
  [
    "GET",
    `/api/hub/admin/premium/delivery/cases/${CASE}/events`,
    `/v1/hub/admin/premium/delivery/cases/${CASE}/events`,
  ],
  [
    "POST",
    `/api/hub/admin/premium/delivery/cases/${CASE}/transition`,
    `/v1/hub/admin/premium/delivery/cases/${CASE}/transition`,
  ],
  ["GET", "/api/hub/admin/premium/players?q=Trainer", "/v1/hub/admin/players?q=Trainer&limit=8"],
  ["GET", "/api/hub/admin/premium/delivery/catalog", "/v1/hub/admin/premium/delivery/catalog"],
  ["POST", "/api/hub/admin/premium/delivery", "/v1/hub/admin/premium/delivery"],
  [
    "GET",
    "/api/hub/admin/premium/delivery/packs/master",
    "/v1/hub/admin/premium/delivery/packs/master",
  ],
  [
    "POST",
    "/api/hub/admin/premium/delivery/packs/master",
    "/v1/hub/admin/premium/delivery/packs/master",
  ],
  ["GET", "/api/hub/admin/premium/delivery/items", "/v1/hub/admin/premium/delivery/items"],
  ["POST", "/api/hub/admin/premium/delivery/items", "/v1/hub/admin/premium/delivery/items"],
  ["GET", "/api/hub/admin/premium/delivery/pokemon", "/v1/hub/admin/premium/delivery/pokemon"],
  ["POST", "/api/hub/admin/premium/delivery/pokemon", "/v1/hub/admin/premium/delivery/pokemon"],
  [
    "GET",
    `/api/hub/admin/premium?playerId=${UUID}&resource=orders`,
    `/v1/hub/admin/premium/players/${UUID}/orders`,
  ],
  [
    "GET",
    `/api/hub/admin/premium?playerId=${UUID}&resource=entitlements`,
    `/v1/hub/admin/premium/players/${UUID}/entitlements`,
  ],
  [
    "GET",
    `/api/hub/admin/premium?playerId=${UUID}&resource=deliveries`,
    `/v1/hub/admin/premium/players/${UUID}/deliveries`,
  ],
  [
    "GET",
    `/api/hub/admin/premium?playerId=${UUID}&resource=support`,
    `/v1/hub/admin/premium/players/${UUID}/support`,
  ],
  [
    "POST",
    `/api/hub/admin/premium?playerId=${UUID}&resource=support`,
    `/v1/hub/admin/premium/players/${UUID}/support`,
  ],
];

function botHandler({ signedIn = false } = {}) {
  return new PlayerPortalHttpHandler({
    sessions: {
      verify: () =>
        signedIn
          ? { ok: true, value: IDENTITY }
          : { ok: false, error: { code: "INVALID_SESSION" } },
    },
    admin: {
      resolvePrincipal: async () => null,
      capabilitiesFor: async () => [],
    },
  });
}

test("exact Hub #132 allowlisted Premium routes match live bot HTTP handler authentication", async () => {
  for (const [method, from, expected] of CORPUS) {
    const resolved = resolvePremiumStageAdminRoute(endpoint(from), method);
    assert.deepEqual(
      resolved,
      { upstreamPath: expected, allowedMethod: method },
      `Hub route changed: ${method} ${from}`,
    );
    for (const authorizedCookie of [false, true]) {
      const response = await botHandler({ signedIn: authorizedCookie }).handle(
        new Request(`https://staging-bot.test${expected}`, {
          method,
          ...(method === "POST"
            ? {
                body: "{}",
                headers: {
                  ...(authorizedCookie ? { cookie: SESSION_COOKIE } : {}),
                  "content-type": "application/json",
                },
              }
            : { headers: authorizedCookie ? { cookie: SESSION_COOKIE } : {} }),
        }),
      );
      assert.equal(
        response.status,
        authorizedCookie ? 403 : 401,
        `Hub and bot permission mismatch: ${method} ${expected} (session=${authorizedCookie})`,
      );
    }
  }
});

test("Hub refuses all checkout/player commercial routes and malformed Premium proxy requests", () => {
  for (const [method, path] of [
    ["POST", "/api/hub/player/premium/orders"],
    ["GET", "/api/hub/player/premium/orders"],
    ["POST", "/api/hub/admin/premium/orders/123/approve"],
    ["POST", "/api/hub/admin/premium/delivery/catalog"],
    ["GET", "/api/hub/admin/premium/delivery?extra=1"],
    ["POST", "/api/hub/admin/premium/delivery?extra=1"],
    ["GET", "/api/hub/admin/premium/delivery/cases?playerId=bad-id"],
    ["GET", "/api/hub/admin/premium?playerId=bad-id&resource=orders"],
    ["GET", `/api/hub/admin/premium?playerId=${UUID}&resource=unknown`],
    ["GET", "/api/hub/admin/premium/players?q=x"],
    ["POST", "/api/hub/admin/premium/delivery/packs/master?extra=1"],
  ]) {
    assert.equal(
      resolvePremiumStageAdminRoute(endpoint(path), method),
      null,
      `Unexpected Hub Premium permission: ${method} ${path}`,
    );
    assert.equal(resolvePremiumStagePlayerRoute(endpoint(path), method), null);
  }
});

test("Hub preview needs explicit approved HTTPS staging origin, not production upstream", () => {
  const config = {
    vercelEnv: "preview",
    enabled: "1",
    apiBaseUrl: "https://staging.beyond.example",
    approvedOrigin: "https://staging.beyond.example",
    productionApiBaseUrl: "https://pokemon-api.otiosunbots.xyz",
  };
  assert.equal(resolvePremiumStagingApiBaseUrl(config), "https://staging.beyond.example");
  for (const changed of [
    { vercelEnv: "production" },
    { enabled: "0" },
    { approvedOrigin: "https://different.example" },
    { apiBaseUrl: "http://staging.beyond.example" },
    {
      apiBaseUrl: "https://pokemon-api.otiosunbots.xyz",
      approvedOrigin: "https://pokemon-api.otiosunbots.xyz",
    },
    { productionApiBaseUrl: "https://staging.beyond.example" },
    {
      apiBaseUrl: "https://staging.beyond.example/secret",
      approvedOrigin: "https://staging.beyond.example/secret",
    },
  ]) {
    assert.equal(resolvePremiumStagingApiBaseUrl({ ...config, ...changed }), null);
  }
});

test("bot production still refuses Premium grants despite a valid synthetic session", async () => {
  const old = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    for (const path of [
      "/v1/hub/admin/premium/delivery",
      "/v1/hub/admin/premium/delivery/cases",
      "/v1/hub/admin/premium/delivery/packs/master",
      "/v1/hub/admin/premium/delivery/items",
      "/v1/hub/admin/premium/delivery/pokemon",
    ]) {
      const response = await botHandler({ signedIn: true }).handle(
        new Request("https://staging-bot.test" + path, {
          method: "POST",
          headers: { cookie: SESSION_COOKIE, "content-type": "application/json" },
          body: "{}",
        }),
      );
      assert.equal(response.status, 503, `Production inadvertently enabled ${path}`);
    }
  } finally {
    if (old === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = old;
  }
});

test("actual Hub delivery client crosses its proxy into bot without duplicate synthetic grant", async () => {
  const { readManualDeliveryCatalog, submitManualDelivery } = await import(
    pathToFileURL(join(hubRoot, "src/player-api/manualPremiumDeliveryClient.ts")).href
  );
  const ownerPrincipalId = "33333333-3333-4333-8333-333333333333";
  const requestId = "44444444-4444-4444-8444-444444444444";
  const playerId = "55555555-5555-4555-8555-555555555555";
  const delivered = new Map();
  let grants = 0;
  const delivery = {
    catalog: async () => [
      {
        sku: "2XP",
        title: "Experiencia dobrada",
        maxQuantity: 52,
        entitlementKey: "XP_2X",
        grantModel: "TIMED",
        durationSecondsPerUnit: 86_400,
      },
    ],
    history: async () => [],
    deliver: async (input) => {
      const previous = delivered.get(input.requestId);
      if (previous !== undefined) {
        return { kind: "APPLIED", replayed: true, entitlement: previous };
      }
      grants += 1;
      const entitlement = {
        playerId: input.playerId,
        entitlementKey: "XP_2X",
        currentlyActive: true,
      };
      delivered.set(input.requestId, entitlement);
      return { kind: "APPLIED", replayed: false, entitlement };
    },
  };

  function makeBridge({ isOwner = false, signedIn = true } = {}) {
    const handler = new PlayerPortalHttpHandler({
      sessions: {
        verify: () => ({ ok: true, value: IDENTITY }),
      },
      admin: {
        resolvePrincipal: async () => ({ principalId: ownerPrincipalId }),
        capabilitiesFor: async () => ["central.view"],
      },
      adminTeam: { isOwner: async () => isOwner },
      premiumDelivery: delivery,
    });
    return async (input, init = {}) => {
      const method = init.method ?? "GET";
      const resolved = resolvePremiumStageAdminRoute(endpoint(input), method);
      if (!resolved) return Response.json({ error: "HUB_ROUTE_REJECTED" }, { status: 404 });
      const headers = new Headers(init.headers);
      if (signedIn) headers.set("cookie", SESSION_COOKIE);
      const forwarded = new Request(
        "https://staging-bot.test" + resolved.upstreamPath,
        {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
        },
      );
      return handler.handle(forwarded);
    };
  }

  const payload = {
    requestId,
    playerId,
    sku: "2XP",
    quantity: 1,
    reason: "Prova sintética de entrega manual aprovada.",
  };
  const guest = await submitManualDelivery(
    payload,
    makeBridge({ signedIn: false, isOwner: true }),
  );
  assert.equal(guest.status, "unauthenticated");

  const nonOwner = await submitManualDelivery(
    payload,
    makeBridge({ isOwner: false }),
  );
  assert.equal(nonOwner.status, "forbidden");
  assert.equal(grants, 0);

  const owner = makeBridge({ isOwner: true });
  const catalog = await readManualDeliveryCatalog(owner);
  assert.equal(catalog[0]?.sku, "2XP");
  const first = await submitManualDelivery(payload, owner);
  assert.deepEqual(first, {
    status: "applied",
    replayed: false,
    requestId,
  });
  const replay = await submitManualDelivery(payload, owner);
  assert.deepEqual(replay, {
    status: "applied",
    replayed: true,
    requestId,
  });
  assert.equal(grants, 1, "Repeated Hub command must keep the original grant");

  const uncertain = await submitManualDelivery(
    { ...payload, requestId: "66666666-6666-4666-8666-666666666666" },
    async () => new Response(null, { status: 503 }),
  );
  assert.equal(uncertain.status, "uncertain", "Gateway timeout is NOT an applied grant");
  assert.equal(grants, 1);
});
