import { describe, expect, it } from "vitest";
import type { InstalledBaileysIdentity } from "../../src/adapters/whatsapp/baileys-package-version.js";
import {
  assertWhatsAppPairingProviderIdentitySupported,
  WhatsAppPairingProviderVersionBlockedError,
} from "../../src/operations/whatsapp-pairing-bootstrap.js";

const PATCHED_RC14: InstalledBaileysIdentity = {
  version: "7.0.0-rc14",
  pairingCompatibility: "rc14-companion-reg-refresh-v1",
};

describe("WhatsApp pairing provider identity gate", () => {
  it("accepts only the exact audited rc14 compatibility identity in staging", () => {
    expect(() =>
      assertWhatsAppPairingProviderIdentitySupported(PATCHED_RC14, "staging"),
    ).not.toThrow();
  });

  it.each<InstalledBaileysIdentity>([
    { version: "7.0.0-rc14", pairingCompatibility: null },
    { version: "7.0.0-rc14", pairingCompatibility: "wrong-marker" },
    { version: "7.0.0-rc15", pairingCompatibility: null },
    { version: "7.0.0-rc15", pairingCompatibility: "rc14-companion-reg-refresh-v1" },
    { version: "", pairingCompatibility: "rc14-companion-reg-refresh-v1" },
  ])("fails closed for unsupported provider identity %#", (identity) => {
    expect(() => assertWhatsAppPairingProviderIdentitySupported(identity, "staging")).toThrow(
      WhatsAppPairingProviderVersionBlockedError,
    );
  });
});
