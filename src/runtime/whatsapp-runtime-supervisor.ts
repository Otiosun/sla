import type { OutboxWorkerRunResult } from "../modules/messaging/service.js";
import type { StructuredLogger } from "../platform/logging/index.js";

export interface ManagedWhatsAppRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  flushOutbox(): Promise<OutboxWorkerRunResult>;
}

export interface WhatsAppRuntimeSupervisorOptions {
  readonly pollIntervalMs: number;
  readonly logger: StructuredLogger;
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class WhatsAppRuntimeSupervisor {
  public constructor(
    private readonly runtime: ManagedWhatsAppRuntime,
    private readonly options: WhatsAppRuntimeSupervisorOptions,
  ) {
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new Error("WhatsApp outbox poll interval must be a positive safe integer");
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    await this.runtime.start();
    this.options.logger.log("INFO", "whatsapp.runtime.started");
    try {
      while (!signal.aborted) {
        const result = await this.runtime.flushOutbox();
        if (result.claimed > 0) {
          this.options.logger.log("DEBUG", "whatsapp.outbox.flush", result);
        }
        await waitForPoll(this.options.pollIntervalMs, signal);
      }
    } finally {
      await this.runtime.stop();
      this.options.logger.log("INFO", "whatsapp.runtime.stopped");
    }
  }
}
