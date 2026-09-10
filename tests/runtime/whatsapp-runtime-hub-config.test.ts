import { describe, expect, it } from "vitest";
import {
  loadWhatsAppRuntimeConfig,
  WhatsAppRuntimeConfigError,
} from "../../src/runtime/whatsapp-runtime-config.js";

const AUTH_KEY = Buffer.alloc(32, 7).toString("base64");

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    WHATSAPP_SESSION_KEY: "pokemon-local",
    WHATSAPP_AUTH_KEY_BASE64: AUTH_KEY,
    ...overrides,
  };
}

describe("WhatsApp Hub runtime config", () => {
  it("accepts an HTTPS public Hub URL", () => {
    const config = loadWhatsAppRuntimeConfig(
      { appEnv: "development" },
      env({ HUB_PUBLIC_URL: "https://hub.example.test/" }),
    );

    expect(config?.hubPublicUrl).toBe("https://hub.example.test/");
  });

  it("keeps the Hub command disabled when no public URL is configured", () => {
    const config = loadWhatsAppRuntimeConfig({ appEnv: "development" }, env());

    expect(config?.hubPublicUrl).toBeNull();
  });

  it("rejects a plaintext public Hub URL", () => {
    expect(() =>
      loadWhatsAppRuntimeConfig(
        { appEnv: "development" },
        env({ HUB_PUBLIC_URL: "http://hub.example.test/" }),
      ),
    ).toThrow(WhatsAppRuntimeConfigError);
  });
});
