import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresExpeditionOfflineActionableMenuIssuer } from "../../src/platform/exploration/postgres-expedition-offline-actionable-menu-issuer.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const input = {
  playerId: createPlayerId(),
  outcomeId: "533a9c5f-0bc5-47de-af4b-68d6a33bc3cc",
  encounterId: "58ecf9b4-314a-4815-a94e-63bd6c94f529",
  expectedEncounterRevision: 2n,
  destinationRef: "5579999999999@s.whatsapp.net",
  correlationId: "aa98e1ad-6722-47b8-9654-f55c2531b79a",
};

afterEach(() => vi.unstubAllEnvs());

describe("offline-only ACTIONABLE menu issuer hard gate", () => {
  it.each([
    { appEnv: "production", nodeEnv: "test", whatsapp: "false" },
    { appEnv: "staging", nodeEnv: "test", whatsapp: "false" },
    { appEnv: "test", nodeEnv: "production", whatsapp: "false" },
    { appEnv: "test", nodeEnv: "test", whatsapp: "true" },
  ])("fails closed without reading DB in environment $appEnv/$whatsapp", async (mode) => {
    vi.stubEnv("APP_ENV", mode.appEnv);
    vi.stubEnv("NODE_ENV", mode.nodeEnv);
    vi.stubEnv("WHATSAPP_ENABLED", mode.whatsapp);
    const connect = vi.fn();
    const issuer = new PostgresExpeditionOfflineActionableMenuIssuer({
      connect,
    } as unknown as Pool);
    expect(await issuer.issue(input)).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
