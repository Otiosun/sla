import { describe, expect, it, vi } from "vitest";
import type { BaileysWaWebVersion } from "../../src/adapters/whatsapp/baileys-provider-contracts.js";
import {
  runWhatsAppPairingBootstrap,
  WhatsAppPairingProviderVersionBlockedError,
} from "../../src/operations/whatsapp-pairing-bootstrap.js";

const REVISION = "a".repeat(40);
const AUTH_KEY = Buffer.alloc(32, 0x63);
const WA_WEB_VERSION: BaileysWaWebVersion = [2, 3000, 1042626022];
const SOCKET_REACHED = new Error("staging candidate reached socket factory");

function config(appEnv: "staging" | "production") {
  return {
    appEnv,
    sessionKey: `pokemon-${appEnv}`,
    authEncryptionKey: AUTH_KEY,
    authEncryptionKeyVersion: 1,
    deploymentRevision: REVISION,
    timeoutMs: 1_000,
  };
}

function reservation() {
  return {
    commit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("WhatsApp provider candidate policy", () => {
  it("allows the exact rc14 package to reach pairing only in staging", async () => {
    const reserveBootstrap = vi.fn(async () => reservation());
    const socketFactory = vi.fn(() => {
      throw SOCKET_REACHED;
    });

    await expect(
      runWhatsAppPairingBootstrap({
        config: config("staging"),
        providerVersion: "7.0.0-rc14",
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap,
        socketFactory,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBe(SOCKET_REACHED);

    expect(reserveBootstrap).toHaveBeenCalledTimes(1);
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it("keeps rc14 blocked in production before reservation or socket creation", async () => {
    const reserveBootstrap = vi.fn(async () => reservation());
    const socketFactory = vi.fn(() => {
      throw SOCKET_REACHED;
    });

    await expect(
      runWhatsAppPairingBootstrap({
        config: config("production"),
        providerVersion: "7.0.0-rc14",
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap,
        socketFactory,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(reserveBootstrap).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("blocks unreviewed package versions even in staging", async () => {
    const reserveBootstrap = vi.fn(async () => reservation());
    const socketFactory = vi.fn(() => {
      throw SOCKET_REACHED;
    });

    await expect(
      runWhatsAppPairingBootstrap({
        config: config("staging"),
        providerVersion: "7.0.0-rc15",
        waWebVersion: WA_WEB_VERSION,
        reserveBootstrap,
        socketFactory,
        qrSink: { render: vi.fn(async () => {}) },
      }),
    ).rejects.toBeInstanceOf(WhatsAppPairingProviderVersionBlockedError);

    expect(reserveBootstrap).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
