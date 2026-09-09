import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { WorldServiceMediaCatalog } from "../../src/modules/world-services/whatsapp-handlers.js";

const routeComposition = vi.hoisted(() => ({
  dependencies: vi.fn(),
}));

vi.mock("../../src/modules/world-services/whatsapp-handlers.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/modules/world-services/whatsapp-handlers.js")
  >("../../src/modules/world-services/whatsapp-handlers.js");
  return {
    ...actual,
    createWorldServiceWhatsAppRoutes: (dependencies: unknown) => {
      routeComposition.dependencies(dependencies);
      return actual.createWorldServiceWhatsAppRoutes(dependencies as never);
    },
  };
});

import { createOperationalMessagingComposition } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("World Service media runtime composition", () => {
  it("injects the configured media catalog into World Service WhatsApp routes", () => {
    const pool = {} as Pool;
    const media: WorldServiceMediaCatalog = {
      pokemartEntry: vi.fn(() => null),
    };

    createOperationalMessagingComposition(pool, null, media);

    expect(routeComposition.dependencies).toHaveBeenCalledOnce();
    const dependencies = routeComposition.dependencies.mock.calls[0]?.[0] as {
      media?: WorldServiceMediaCatalog;
    };
    expect(dependencies.media).toBe(media);
  });
});
