import { appError, err, ok, type AppError, type Result } from "../../shared-kernel/result.js";
import {
  IncomingMessageSchema,
  incomingMessageIdempotencyKey,
  MediaProcessingRequestSchema,
  OutgoingMessageDraftSchema,
  type IncomingMessage,
  type MessageHandlerContext,
  type MessageHandlerResult,
  type MessagingRateLimitRule,
} from "./contracts.js";
import { presentMessagingError } from "./errors.js";
import type {
  MediaProcessorAdapter,
  MessagingRepository,
  MessageRouterPort,
  OutboundMessageAdapter,
  OutboxDeliveryPreparation,
} from "./ports.js";

export interface ReceiveMessageResult {
  readonly status: "PROCESSED" | "REPLAYED" | "IN_FLIGHT";
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
}

export interface MessagingRateLimitPolicy {
  readonly policyKey: string;
  readonly maxEvents: number;
  readonly windowMs: number;
}

export interface MessagingRateLimitPolicySet {
  readonly player: MessagingRateLimitPolicy;
  readonly chat: MessagingRateLimitPolicy;
  readonly sensitiveAction: MessagingRateLimitPolicy;
}

export const DEFAULT_MESSAGING_RATE_LIMIT_POLICY: MessagingRateLimitPolicySet = {
  player: { policyKey: "messaging.player.v1", maxEvents: 20, windowMs: 10_000 },
  chat: { policyKey: "messaging.chat.v1", maxEvents: 100, windowMs: 10_000 },
  sensitiveAction: {
    policyKey: "messaging.sensitive-action.v1",
    maxEvents: 5,
    windowMs: 10_000,
  },
};

function rateLimitRules(
  sensitiveActionKey: string | null,
  policy: MessagingRateLimitPolicySet,
): readonly MessagingRateLimitRule[] {
  const rules: MessagingRateLimitRule[] = [
    {
      scope: "PLAYER",
      policyKey: policy.player.policyKey,
      maxEvents: policy.player.maxEvents,
      windowMs: policy.player.windowMs,
      actionKey: null,
    },
    {
      scope: "CHAT",
      policyKey: policy.chat.policyKey,
      maxEvents: policy.chat.maxEvents,
      windowMs: policy.chat.windowMs,
      actionKey: null,
    },
  ];
  if (sensitiveActionKey !== null) {
    rules.push({
      scope: "ACTION",
      policyKey: policy.sensitiveAction.policyKey,
      maxEvents: policy.sensitiveAction.maxEvents,
      windowMs: policy.sensitiveAction.windowMs,
      actionKey: sensitiveActionKey,
    });
  }
  return rules;
}

function validateHandlerResult(
  context: MessageHandlerContext,
  result: MessageHandlerResult,
): Result<MessageHandlerResult> {
  for (const outgoing of result.outgoing) {
    const output = OutgoingMessageDraftSchema.safeParse(outgoing);
    if (!output.success) {
      return err(
        appError("VALIDATION_FAILED", "Handler produced an invalid outgoing message", {
          correlationId: context.correlationId,
        }),
      );
    }
  }
  for (const mediaRequest of result.mediaProcessing ?? []) {
    const request = MediaProcessingRequestSchema.safeParse(mediaRequest);
    if (!request.success) {
      return err(
        appError("VALIDATION_FAILED", "Handler produced an invalid media processing request", {
          correlationId: context.correlationId,
        }),
      );
    }
    if (
      !context.message.mediaRefs.some(
        (reference) => reference.providerMediaId === request.data.providerMediaId,
      )
    ) {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Handler requested media that is not present in the message",
          {
            correlationId: context.correlationId,
          },
        ),
      );
    }
  }
  return ok(result);
}

export class MessagingService {
  constructor(
    private readonly repository: MessagingRepository,
    private readonly router: MessageRouterPort,
    private readonly inboxLeaseMs = 30_000,
    private readonly rateLimitPolicy: MessagingRateLimitPolicySet = DEFAULT_MESSAGING_RATE_LIMIT_POLICY,
  ) {}

  private async complete(
    context: MessageHandlerContext,
    result: MessageHandlerResult,
  ): Promise<Result<ReceiveMessageResult>> {
    const validated = validateHandlerResult(context, result);
    if (!validated.ok) {
      await this.repository.failIncoming(context.inboxMessageId, "INVALID_HANDLER_RESULT");
      return validated;
    }
    const completed = await this.repository.completeIncoming(
      context.inboxMessageId,
      validated.value,
    );
    if (!completed.ok) return completed;
    return ok({
      status: "PROCESSED",
      inboxMessageId: context.inboxMessageId,
      correlationId: context.correlationId,
      resultRefType: validated.value.resultRefType,
      resultRefId: validated.value.resultRefId,
    });
  }

  private async completeFriendlyError(
    context: MessageHandlerContext,
    error: AppError,
  ): Promise<Result<ReceiveMessageResult>> {
    return this.complete(context, presentMessagingError(context, error));
  }

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

    const routing = this.router.classify(context.message);
    const admission = await this.repository.consumeRateLimits({
      inboxMessageId: context.inboxMessageId,
      message: context.message,
      rules: rateLimitRules(routing.sensitiveActionKey, this.rateLimitPolicy),
    });
    if (!admission.ok) {
      await this.repository.failIncoming(context.inboxMessageId, admission.error.code);
      return admission;
    }
    if (!admission.value.allowed) {
      return this.completeFriendlyError(
        context,
        appError("RATE_LIMITED", "Messaging rate limit exceeded", {
          scope: admission.value.limitedScope,
          retryAfterMs: admission.value.retryAfterMs,
        }),
      );
    }

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
      return this.completeFriendlyError(context, routed.error);
    }

    const handlerResult: MessageHandlerResult = routed.value ?? {
      resultRefType: null,
      resultRefId: null,
      outgoing: [],
    };
    return this.complete(context, handlerResult);
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

function retryAtForAttempt(input: {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}): Date | null {
  if (input.attempts >= input.maxAttempts) return null;
  const exponent = Math.max(0, input.attempts - 1);
  const delay = Math.min(input.maxBackoffMs, input.baseBackoffMs * 2 ** Math.min(exponent, 20));
  return new Date(Date.now() + delay);
}

export class OutboxWorker {
  private readonly adapters: ReadonlyMap<string, OutboundMessageAdapter>;

  constructor(
    private readonly repository: MessagingRepository,
    adapters: readonly OutboundMessageAdapter[],
    private readonly options: OutboxWorkerOptions,
    private readonly deliveryPreparation?: OutboxDeliveryPreparation,
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
        await this.deliveryPreparation?.prepare(message);
        await adapter.send(message);
        await this.repository.markOutboxSent(message.id);
        sent += 1;
      } catch {
        await this.repository.markOutboxFailed({
          outboxMessageId: message.id,
          errorCode: "OUTBOX_DELIVERY_FAILED",
          retryAt: retryAtForAttempt({
            attempts: message.attempts,
            maxAttempts: this.options.maxAttempts,
            baseBackoffMs: this.options.baseBackoffMs,
            maxBackoffMs: this.options.maxBackoffMs,
          }),
          maxAttempts: this.options.maxAttempts,
        });
        failed += 1;
      }
    }

    return { claimed: messages.length, sent, failed };
  }
}

export type MediaWorkerOptions = OutboxWorkerOptions;

export interface MediaWorkerRunResult {
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
}

export class MediaWorker {
  private readonly processors: ReadonlyMap<string, MediaProcessorAdapter>;

  constructor(
    private readonly repository: MessagingRepository,
    processors: readonly MediaProcessorAdapter[],
    private readonly options: MediaWorkerOptions,
  ) {
    this.processors = new Map(processors.map((processor) => [processor.processorKey, processor]));
  }

  async runOnce(): Promise<MediaWorkerRunResult> {
    const jobs = await this.repository.claimMediaJobs({
      limit: this.options.batchSize,
      staleAfterMs: this.options.staleAfterMs,
      maxAttempts: this.options.maxAttempts,
    });
    let processed = 0;
    let failed = 0;

    for (const job of jobs) {
      const processor = this.processors.get(job.processorKey);
      if (processor === undefined) {
        await this.repository.markMediaJobFailed({
          mediaJobId: job.id,
          errorCode: "MEDIA_PROCESSOR_UNAVAILABLE",
          retryAt: null,
          maxAttempts: 1,
        });
        failed += 1;
        continue;
      }
      try {
        await processor.process(job);
        await this.repository.markMediaJobProcessed(job.id);
        processed += 1;
      } catch {
        await this.repository.markMediaJobFailed({
          mediaJobId: job.id,
          errorCode: "MEDIA_PROCESSING_FAILED",
          retryAt: retryAtForAttempt({
            attempts: job.attempts,
            maxAttempts: this.options.maxAttempts,
            baseBackoffMs: this.options.baseBackoffMs,
            maxBackoffMs: this.options.maxBackoffMs,
          }),
          maxAttempts: this.options.maxAttempts,
        });
        failed += 1;
      }
    }

    return { claimed: jobs.length, processed, failed };
  }
}
