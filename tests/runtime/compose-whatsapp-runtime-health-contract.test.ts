import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { BaileysAuthBinding } from "../../src/adapters/whatsapp/baileys-whatsapp-adapter.js";
import type { WhatsAppProviderConnectionState } from "../../src/adapters/whatsapp/adapter.js";
import type { StructuredLogger } from "../../src/platform/logging/index.js";
import type { OperationalWhatsAppRuntimeOptions } from "../../src/runtime/compose-whatsapp-runtime.js";

describe("operational WhatsApp runtime health composition contract", () => {
  it("accepts a provider-neutral connection-state sink at the composition boundary", () => {
    const onProviderConnectionState = vi.fn(async (_state: WhatsAppProviderConnectionState) => {});
    const options: OperationalWhatsAppRuntimeOptions = {
      pool: {} as Pool,
      auth: { state: {}, async saveCredentials() {} } satisfies BaileysAuthBinding,
      logger: {} as StructuredLogger,
      onProviderConnectionState,
    };

    expect(options.onProviderConnectionState).toBe(onProviderConnectionState);
  });
});
