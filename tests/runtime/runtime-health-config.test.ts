import { describe, expect, it } from "vitest";
import {
  loadWhatsAppRuntimeConfig,
  WhatsAppRuntimeConfigError,
} from "../../src/runtime/whatsapp-runtime-config.js";

const authKey = Buffer.alloc(32, 0x24).toString("base64");
const revision = "1234567890abcdef1234567890abcdef12345678";

describe("release runtime health configuration", () => {
  it("requires an exact deployment revision in staging and production", () => {
    expect(() =>
      loadWhatsAppRuntimeConfig(
        { appEnv: "staging" },
        {
          WHATSAPP_SESSION_KEY: "staging-main",
          WHATSAPP_AUTH_KEY_BASE64: authKey,
        },
      ),
    ).toThrow(WhatsAppRuntimeConfigError);

    expect(() =>
      loadWhatsAppRuntimeConfig(
        { appEnv: "production" },
        {
          WHATSAPP_SESSION_KEY: "prod-main",
          WHATSAPP_AUTH_KEY_BASE64: authKey,
          DEPLOY_REVISION: "short-sha",
        },
      ),
    ).toThrow(WhatsAppRuntimeConfigError);
  });

  it("binds release runtime health to the full revision and defaults heartbeat to 30 seconds", () => {
    const config = loadWhatsAppRuntimeConfig(
      { appEnv: "staging" },
      {
        WHATSAPP_SESSION_KEY: "staging-main",
        WHATSAPP_AUTH_KEY_BASE64: authKey,
        DEPLOY_REVISION: revision,
      },
    );

    expect(config?.deploymentRevision).toBe(revision);
    expect(config?.healthHeartbeatMs).toBe(30_000);
  });

  it("accepts an explicit positive heartbeat interval", () => {
    const config = loadWhatsAppRuntimeConfig(
      { appEnv: "production" },
      {
        WHATSAPP_SESSION_KEY: "prod-main",
        WHATSAPP_AUTH_KEY_BASE64: authKey,
        DEPLOY_REVISION: revision,
        WHATSAPP_HEALTH_HEARTBEAT_MS: "45000",
      },
    );

    expect(config?.healthHeartbeatMs).toBe(45_000);
  });
});
