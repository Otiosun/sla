import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  OutgoingMessageDraftSchema,
  type IncomingMessage,
  type MessageHandlerResult,
} from "./contracts.js";
import type { MessagingRepository, MessageRouterPort, OutboundMessageAdapter } from "./ports.js";

export interface ReceiveMessageResult {
  readonly status: "PROCESSED" | "REPLAYED" | "IN_FLIGHT";
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
}

export class MessagingService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly router: MessageRouterPort,
    private readonly inboxLeaseMs = 30_000,
  ) {}

  async receive(input: unknown): Promise<Result<ReceiveMessageResult>> {
    const parsed = IncomingMessageSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        appError("VALIDATION_FAILED", "Incoming message is invalid", {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        }),
      );
    }
    const message: IncomingMessage = parsed.data;
    const claim = await this.repository.claimIncoming(message, this.inboxLeaseMs);
    if (!claim.ok) return claim;

    if (claim.value.status === "REPLAYED") {
      return ok({
        status: "REPLAYED",
        inboxMessageId: claim.value.inboxMessageId,
        correlationId: claim.value.correlationId,
        resultRefType: claim.value.resultRefType,
        resultRefId: claim.value.resultRefId,
      });
    }
    if (claim.value.status === "IN_FLIGHT") {
      return ok({
        status: "IN_FLIGHT",
        inboxMessageId: claim.value.inboxMessageId,
        correlationId: claim.value.correlationId,
        resultRefType: null,
        resultRefId: null,
      });
    }

    const context = {
      inboxMessageId: claim.value.inboxMessageId,
      correlationId: claim.value.correlationId,
      causationId: claim.value.inboxMessageId,
      idempotencyKey: incomingMessageIdempotencyKey(message),
      message: claim.value.message,
    } as const;

    let routed: Awaited<ReturnType<MessageRouterPort["dispatch"]>>;
    try {
      routed = await this.router.dispatch(context);
    } catch {
      await this.repository.failIncoming(claim.value.inboxMessageId, "UNHANDLED_ROUTER_ERROR");
      return err(
        appError("ACTION_INVALID", "Message processing failed", {
          correlationId: claim.value.correlationId,
        }),
      );
    }
    if (!routed.ok) {
      await this.repository.failIncoming(claim.value.inboxMessageId, routed.error.code);
      return routed;
    }

    const handlerResult: MessageHandlerResult = routed.value ?? {
      resultRefType: null,
      resultRefId: null,
      outgoing: [],
    };
    for (const outgoing of handlerResult.outgoing) {
      const output = OutgoingMessageDraftSchema.safeParse(outgoing);
      if (!output.success) {
        await this.repository.failIncoming(claim.value.inboxMessageId, "INVALID_OUTBOX_DRAFT");
        return err(
          appError("VALIDATION_FAILED", "Handler produced an invalid outgoing message", {
            correlationId: claim.value.correlationId,
          }),
        );
      }
    }

    const completed = await this.repository.completeIncoming(
      claim.value.inboxMessageId,
      handlerResult,
    );
    if (!completed.ok) return completed;

    return ok({
      status: "PROCESSED",
      inboxMessageId: claim.value.inboxMessageId,
      correlationId: claim.value.correlationId,
      resultRefType: handlerResult.resultRefType,
      resultRefId: handlerResult.resultRefId,
    });
  }
}

export interface OutboxWorkerOptions {
  readonly batchSize: number;
  readonly staleAfterMs: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface OutboxWorkerRunResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
}

export class OutboxWorker {
  private readonly adapters: ReadonlyMap<string, OutboundMessageAdapter>;

  constructor(
    private readonly repository: MessagingRepository,
    adapters: readonly OutboundMessageAdapter[],
    private readonly options: OutboxWorkerOptions,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.channel, adapter]));
  }

  async runOnce(): Promise<OutboxWorkerRunResult> {
    const messages = await this.repository.claimOutbox({
      limit: this.options.batchSize,
      staleAfterMs: this.options.staleAfterMs,
      maxAttempts: this.options.maxAttempts,
    });
    let sent = 0;
    let failed = 0;

    for (const message of messages) {
      const adapter = this.adapters.get(message.channel);
      if (adapter === undefined) {
        await this.repository.markOutboxFailed({
          outboxMessageId: message.id,
          errorCode: "OUTBOX_CHANNEL_UNAVAILABLE",
          retryAt: null,
          maxAttempts: 1,
        });
        failed += 1;
        continue;
      }
      try {
        await adapter.send(message);
        await this.repository.markOutboxSent(message.id);
        sent += 1;
      } catch {
        const exponent = Math.max(0, message.attempts - 1);
        const delay = Math.min(
          this.options.maxBackoffMs,
          this.options.baseBackoffMs * 2 ** Math.min(exponent, 20),
        );
        const retryAt =
          message.attempts >= this.options.maxAttempts ? null : new Date(Date.now() + delay);
        await this.repository.markOutboxFailed({
          outboxMessageId: message.id,
          errorCode: "OUTBOX_DELIVERY_FAILED",
          retryAt,
          maxAttempts: this.options.maxAttempts,
        });
        failed += 1;
      }
    }

    return { claimed: messages.length, sent, failed };
  }
}
