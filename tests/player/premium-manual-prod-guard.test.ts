import { describe, expect, it } from "vitest";
import { PlayerPortalHttpHandler } from "../../src/modules/player-portal/http-handler.js";

const playerId = "11111111-1111-4111-8111-111111111111";
const caseId = "22222222-2222-4222-8222-222222222222";
const routes = [
  ["GET", "/v1/hub/admin/premium/delivery/catalog"],
  ["POST", "/v1/hub/admin/premium/delivery"],
  ["GET", "/v1/hub/admin/premium/delivery/cases/catalog"],
  ["POST", "/v1/hub/admin/premium/delivery/cases"],
  ["GET", `/v1/hub/admin/premium/delivery/cases?playerId=${playerId}`],
  ["GET", `/v1/hub/admin/premium/delivery/cases/${caseId}/events`],
  ["POST", `/v1/hub/admin/premium/delivery/cases/${caseId}/transition`],
  ["GET", `/v1/hub/admin/premium/players/${playerId}/deliveries`],
] as const;

describe("Premium generic manual workflow environment boundary", () => {
  it("blocks all eight routes in production, even when staging flag is set", async () => {
    const savedEnv = process.env.APP_ENV;
    const savedFlag = process.env.PREMIUM_MANUAL_DELIVERY_ENABLED;
    try {
      for (const [environment, flag] of [
        ["production", "1"],
        ["staging", "0"],
      ] as const) {
        process.env.APP_ENV = environment;
        process.env.PREMIUM_MANUAL_DELIVERY_ENABLED = flag;
        // Deliberately no session or DB dependencies: gate must run first.
        const handler = new PlayerPortalHttpHandler(
          {} as ConstructorParameters<typeof PlayerPortalHttpHandler>[0],
        );
        for (const [method, route] of routes) {
          const response = await handler.handle(new Request(
            `https://staging.invalid${route}`,
            {
              method,
              ...(method === "POST" ? { body: "{}" } : {}),
            },
          ));
          expect(response.status, `${environment} ${method} ${route}`).toBe(503);
          expect(await response.json()).toMatchObject({ error: "PREMIUM_DELIVERY_DISABLED" });
        }
      }
    } finally {
      if (savedEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = savedEnv;
      if (savedFlag === undefined) delete process.env.PREMIUM_MANUAL_DELIVERY_ENABLED;
      else process.env.PREMIUM_MANUAL_DELIVERY_ENABLED = savedFlag;
    }
  });
});