import type {
  MessagingService,
  OutboxWorker,
  OutboxWorkerRunResult,
} from "../../modules/messaging/service.js";
import type { WhatsAppAdapter } from "./adapter.js";

export class WhatsAppMessagingRuntime {
  constructor(
    private readonly adapter: WhatsAppAdapter,
    private readonly messaging: MessagingService,
    private readonly outboxWorker: OutboxWorker,
  ) {}

  async start(): Promise<void> {
    await this.adapter.start(async (message) => {
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
