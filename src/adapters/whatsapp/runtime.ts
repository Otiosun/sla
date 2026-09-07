import type { IncomingMessage } from "../../modules/messaging/contracts.js";
import type {
  MessagingService,
  OutboxWorker,
  OutboxWorkerRunResult,
} from "../../modules/messaging/service.js";
import type { WhatsAppAdapter } from "./adapter.js";

export interface WhatsAppMessagingRuntimeOptions {
  readonly admitCommand?: (message: IncomingMessage) => Promise<boolean> | boolean;
  readonly admitFreeform?: (message: IncomingMessage) => Promise<boolean> | boolean;
  readonly beforeOutboxFlush?: () => Promise<void>;
}

export class WhatsAppMessagingRuntime {
  constructor(
    private readonly adapter: WhatsAppAdapter,
    private readonly messaging: MessagingService,
    private readonly outboxWorker: OutboxWorker,
    private readonly options: WhatsAppMessagingRuntimeOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.adapter.start(async (message) => {
      const text = message.text?.trimStart();
      const prefix = text?.[0];
      const commandCandidate = prefix === "$" || prefix === "/";
      if (commandCandidate) {
        const admitCommand = this.options.admitCommand;
        if (admitCommand !== undefined && !(await admitCommand(message))) return;
      } else {
        const admitFreeform = this.options.admitFreeform;
        if (admitFreeform === undefined || !(await admitFreeform(message))) return;
      }
      await this.messaging.receive(message);
    });
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  async flushOutbox(): Promise<OutboxWorkerRunResult> {
    await this.options.beforeOutboxFlush?.();
    return this.outboxWorker.runOnce();
  }
}
