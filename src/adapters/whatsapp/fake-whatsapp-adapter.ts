import type { IncomingMessage, PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboundMessageReceipt } from "../../modules/messaging/ports.js";
import type { WhatsAppAdapter, WhatsAppIncomingHandler } from "./adapter.js";

export class FakeWhatsAppAdapter implements WhatsAppAdapter {
  readonly channel = "whatsapp" as const;
  readonly sent: PendingOutboxMessage[] = [];
  private incomingHandler: WhatsAppIncomingHandler | null = null;
  private failuresRemaining = 0;

  async start(onIncoming: WhatsAppIncomingHandler): Promise<void> {
    if (this.incomingHandler !== null) {
      throw new Error("Fake WhatsApp adapter is already started");
    }
    this.incomingHandler = onIncoming;
  }

  async stop(): Promise<void> {
    this.incomingHandler = null;
  }

  failNext(count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("Fake WhatsApp failure count must be a non-negative integer");
    }
    this.failuresRemaining += count;
  }

  async inject(message: IncomingMessage): Promise<void> {
    const handler = this.incomingHandler;
    if (handler === null) {
      throw new Error("Fake WhatsApp adapter is not started");
    }
    await handler(message);
  }

  async send(message: PendingOutboxMessage): Promise<OutboundMessageReceipt> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Simulated WhatsApp delivery failure");
    }
    this.sent.push(message);
    return { providerExternalMessageId: `fake:${message.id}` };
  }
}
