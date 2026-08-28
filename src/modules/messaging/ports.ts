import type { AppError, Result } from "../../shared-kernel/result.js";
import type {
  InboxClaim,
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
  PendingOutboxMessage,
} from "./contracts.js";

export interface MessageRouteHandler {
  handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>>;
}

export interface MessagingRepository {
  claimIncoming(message: IncomingMessage, leaseMs: number): Promise<Result<InboxClaim>>;
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
}

export interface MessageRouterPort {
  dispatch(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>>;
}

export interface OutboundMessageAdapter {
  readonly channel: string;
  send(message: PendingOutboxMessage): Promise<void>;
}

export type MessagingResult<T> = Result<T, AppError>;
