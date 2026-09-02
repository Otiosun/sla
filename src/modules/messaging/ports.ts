import type { AppError, Result } from "../../shared-kernel/result.js";
import type {
  InboxClaim,
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
  MessageRoutingMetadata,
  MessagingRateLimitDecision,
  MessagingRateLimitRule,
  PendingMediaJob,
  PendingOutboxMessage,
} from "./contracts.js";

export interface MessageRouteHandler {
  handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>>;
}

export interface MessagingRepository {
  claimIncoming(message: IncomingMessage, leaseMs: number): Promise<Result<InboxClaim>>;
  consumeRateLimits(input: {
    readonly inboxMessageId: string;
    readonly message: IncomingMessage;
    readonly rules: readonly MessagingRateLimitRule[];
  }): Promise<Result<MessagingRateLimitDecision>>;
  completeIncoming(inboxMessageId: string, result: MessageHandlerResult): Promise<Result<void>>;
  failIncoming(inboxMessageId: string, errorCode: string): Promise<void>;
  claimOutbox(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly PendingOutboxMessage[]>;
  markOutboxSent(outboxMessageId: string): Promise<void>;
  markOutboxFailed(input: {
    readonly outboxMessageId: string;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void>;
  claimMediaJobs(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly maxAttempts: number;
  }): Promise<readonly PendingMediaJob[]>;
  markMediaJobProcessed(mediaJobId: string): Promise<void>;
  markMediaJobFailed(input: {
    readonly mediaJobId: string;
    readonly errorCode: string;
    readonly retryAt: Date | null;
    readonly maxAttempts: number;
  }): Promise<void>;
}

export interface MessageRouterPort {
  classify(message: IncomingMessage): MessageRoutingMetadata;
  dispatch(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>>;
}

export interface OutboundMessageReceipt {
  readonly providerExternalMessageId: string | null;
}

export interface OutboundMessageAdapter {
  readonly channel: string;
  send(message: PendingOutboxMessage): Promise<OutboundMessageReceipt>;
}

export interface MediaProcessorAdapter {
  readonly processorKey: string;
  process(job: PendingMediaJob): Promise<void>;
}

export type MessagingResult<T> = Result<T, AppError>;
