import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import {
  type LogSink,
  StructuredLogger,
  type StructuredLogEntry,
} from "../../src/platform/logging/index.js";
import {
  loadWhatsAppRuntimeConfig,
  WhatsAppRuntimeConfigError,
} from "../../src/runtime/whatsapp-runtime-config.js";
import {
  type ManagedWhatsAppRuntime,
  WhatsAppRuntimeSupervisor,
} from "../../src/runtime/whatsapp-runtime-supervisor.js";

class MemoryLogSink implements LogSink {
  readonly entries: StructuredLogEntry[] = [];
  write(entry: StructuredLogEntry): void {
    this.entries.push(entry);
  }
}

function logger(): { readonly logger: StructuredLogger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return {
    logger: new StructuredLogger(new ManualClock(new Date("2026-08-29T21:00:00Z")), sink),
    sink,
  };
}

describe("WhatsApp runtime config", () => {
  it("keeps development/test schema-only when no runtime variables are supplied", () => {
    expect(loadWhatsAppRuntimeConfig({ appEnv: "development" }, {})).toBeNull();
    expect(loadWhatsAppRuntimeConfig({ appEnv: "test" }, {})).toBeNull();
  });

  it("requires a complete runtime configuration in staging and production", () => {
    expect(() => loadWhatsAppRuntimeConfig({ appEnv: "staging" }, {})).toThrow(
      WhatsAppRuntimeConfigError,
    );
  });

  it("accepts only a canonical 32-byte base64 encryption key", () => {
    const encoded = Buffer.alloc(32, 0x42).toString("base64");
    const config = loadWhatsAppRuntimeConfig(
      { appEnv: "production" },
      {
        WHATSAPP_SESSION_KEY: "prod-main",
        WHATSAPP_AUTH_KEY_BASE64: encoded,
        WHATSAPP_AUTH_KEY_VERSION: "2",
        WHATSAPP_OUTBOX_POLL_MS: "750",
      },
    );
    expect(config?.sessionKey).toBe("prod-main");
    expect(config?.authEncryptionKey.equals(Buffer.alloc(32, 0x42))).toBe(true);
    expect(config?.authEncryptionKeyVersion).toBe(2);
    expect(config?.outboxPollMs).toBe(750);

    expect(() =>
      loadWhatsAppRuntimeConfig(
        { appEnv: "staging" },
        {
          WHATSAPP_SESSION_KEY: "staging-main",
          WHATSAPP_AUTH_KEY_BASE64: Buffer.alloc(31, 0x42).toString("base64"),
        },
      ),
    ).toThrow(WhatsAppRuntimeConfigError);
  });
});

describe("WhatsApp runtime supervisor", () => {
  it("runs sequential outbox flushes and stops cleanly after abort", async () => {
    const controller = new AbortController();
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    let flushes = 0;
    const runtime: ManagedWhatsAppRuntime = {
      start,
      stop,
      async flushOutbox() {
        flushes += 1;
        if (flushes === 2) controller.abort();
        return { claimed: 1, sent: 1, failed: 0 };
      },
    };
    const logs = logger();
    const supervisor = new WhatsAppRuntimeSupervisor(runtime, {
      pollIntervalMs: 1,
      logger: logs.logger,
    });

    await supervisor.run(controller.signal);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(flushes).toBe(2);
    expect(logs.sink.entries.map((entry) => entry.event)).toContain("whatsapp.runtime.stopped");
  });

  it("still stops the adapter when outbox infrastructure fails", async () => {
    const stop = vi.fn(async () => {});
    const runtime: ManagedWhatsAppRuntime = {
      start: vi.fn(async () => {}),
      stop,
      async flushOutbox() {
        throw new Error("database unavailable");
      },
    };
    const logs = logger();
    const supervisor = new WhatsAppRuntimeSupervisor(runtime, {
      pollIntervalMs: 1,
      logger: logs.logger,
    });

    await expect(supervisor.run(new AbortController().signal)).rejects.toThrow(
      "database unavailable",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
