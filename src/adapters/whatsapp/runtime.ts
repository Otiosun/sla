import type { IncomingMessage } from "../../modules/messaging/contracts.js";
import type {
  MessagingService,
  OutboxWorker,
  OutboxWorkerRunResult,
} from "../../modules/messaging/service.js";
import type { WhatsAppAdapter } from "./adapter.js";

export interface WhatsAppMessagingRuntimeOptions {
  readonly admitFreeform?: (message: IncomingMessage) => Promise<boolean> | boolean;
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
      const commandCandidate = text?.startsWith("$") ?? false;
      if (!commandCandidate) {
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
    return this.outboxWorker.runOnce();
  }
}
