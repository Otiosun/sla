import { describe, expect, it } from "vitest";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";

describe("operational world route policy", () => {
  it("protects $ir with world capability, ACTIVE access and mechanical readiness", () => {
    const routes = createOperationalUxRoutes({} as never);
    const travel = routes.find((route) => route.command === "ir");

    expect(travel).toBeDefined();
    expect(travel?.policy).toEqual({
      requiredGroupCapabilities: ["world"],
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    });
  });
});
