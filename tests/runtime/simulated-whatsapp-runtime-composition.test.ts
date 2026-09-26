import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  createOperationalSimulatedWhatsAppRuntime,
  simulatedWhatsAppMessage,
} from "../../src/runtime/compose-simulated-whatsapp-runtime.js";

describe("operational simulated WhatsApp runtime", () => {
  it("reuses the real operational router and keeps Baileys provider semantics", () => {
    const runtime = createOperationalSimulatedWhatsAppRuntime({
      pool: {} as Pool,
      now: () => new Date("2026-09-19T23:30:00.000Z"),
    });
    const registration = simulatedWhatsAppMessage({
      externalMessageId: "sim-registration",
      senderRef: "5579999999999@s.whatsapp.net",
      chatRef: "120363000000000001@g.us",
      occurredAt: "2026-09-19T23:30:00.000Z",
      text: "/registrar",
    });
    const menu = { ...registration, externalMessageId: "sim-menu", text: "/Menu" };

    expect(runtime.adapter.channel).toBe("whatsapp");
    expect(registration.provider).toBe("baileys");
    expect(runtime.composition.router.classify(registration)).toEqual({
      command: "registrar",
      sensitiveActionKey: "command:registrar",
    });
    expect(runtime.composition.router.classify(menu)).toEqual({
      command: "menu",
      sensitiveActionKey: null,
    });
    expect(runtime.composition.router.admitsCommand(registration)).toBe(true);
    expect(runtime.composition.router.admitsCommand({ ...registration, text: "$naoexiste" })).toBe(
      false,
    );
  });
});
