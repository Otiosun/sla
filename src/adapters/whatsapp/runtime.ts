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
  readonly onIncomingProcessingFailure?: (input: {
    readonly stage: "COMPLETE_INCOMING";
    readonly errorCode: string;
    readonly correlationId: string | null;
  }) => void;
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
      const received = await this.messaging.receive(message);
      if (!received.ok && received.error.details?.stage === "COMPLETE_INCOMING") {
        const correlationId = received.error.details.correlationId;
        const completionErrorCode = received.error.details.completionErrorCode;
        this.options.onIncomingProcessingFailure?.({
          stage: "COMPLETE_INCOMING",
          errorCode:
            typeof completionErrorCode === "string" ? completionErrorCode : received.error.code,
          correlationId: typeof correlationId === "string" ? correlationId : null,
        });
      }
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
