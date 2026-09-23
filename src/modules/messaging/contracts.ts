import { createHash } from "node:crypto";
import { z } from "zod";

const boundedRef = z.string().trim().min(1).max(512);

export const MediaReferenceSchema = z
  .object({
    providerMediaId: boundedRef,
    kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER", "OTHER"]),
    mimeType: z.string().trim().min(1).max(255).nullable().default(null),
    fileName: z.string().trim().min(1).max(512).nullable().default(null),
  })
  .strict();

export const IncomingMessageSchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    externalMessageId: boundedRef,
    senderRef: boundedRef,
    chatRef: boundedRef,
    occurredAt: z.string().datetime({ offset: true }),
    text: z.string().max(32_768).nullable().default(null),
    mentions: z.array(boundedRef).max(64).optional(),
    mediaRefs: z.array(MediaReferenceSchema).max(16).default([]),
    replyToExternalMessageId: boundedRef.nullable().default(null),
  })
  .strict();

export type MediaReference = z.infer<typeof MediaReferenceSchema>;
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

export const OutgoingMessageDraftSchema = z
  .object({
    channel: z.string().trim().min(1).max(64),
    destinationRef: boundedRef,
    messageType: z.string().trim().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().trim().min(1).max(512),
    delayMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();

export type OutgoingMessageDraft = z.infer<typeof OutgoingMessageDraftSchema>;

export const MediaProcessingRequestSchema = z
  .object({
    providerMediaId: boundedRef,
    processorKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
  })
  .strict();

export type MediaProcessingRequest = z.infer<typeof MediaProcessingRequestSchema>;

export interface MessageHandlerContext {
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly message: IncomingMessage;
  /** Full inbound text before mechanical command extraction. */
  readonly originalMessageText?: string | null;
}

export interface MessageHandlerResult {
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly outgoing: readonly OutgoingMessageDraft[];
  readonly mediaProcessing?: readonly MediaProcessingRequest[];
}

export interface MessageRoutingMetadata {
  readonly command: string | null;
  readonly sensitiveActionKey: string | null;
}

export type MessagingRateLimitScope = "PLAYER" | "CHAT" | "ACTION";

export interface MessagingRateLimitRule {
  readonly scope: MessagingRateLimitScope;
  readonly policyKey: string;
  readonly maxEvents: number;
  readonly windowMs: number;
  readonly actionKey: string | null;
}

export interface MessagingRateLimitDecision {
  readonly allowed: boolean;
  readonly replayed: boolean;
  readonly limitedScope: MessagingRateLimitScope | null;
  readonly retryAfterMs: number;
}

export type InboxClaimStatus = "CLAIMED" | "REPLAYED" | "IN_FLIGHT";

export interface InboxClaim {
  readonly status: InboxClaimStatus;
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly message: IncomingMessage;
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
}

export interface PendingOutboxMessage {
  readonly id: string;
  readonly channel: string;
  readonly destinationRef: string;
  readonly messageType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly attempts: number;
}

export interface PendingMediaJob {
  readonly id: string;
  readonly inboxMessageId: string;
  readonly provider: string;
  readonly providerMediaId: string;
  readonly mediaKind: MediaReference["kind"];
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly processorKey: string;
  readonly correlationId: string;
  readonly attempts: number;
}

export function incomingMessageFingerprint(message: IncomingMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function incomingMessageIdempotencyKey(message: IncomingMessage): string {
  return `inbox:${message.provider}:${message.externalMessageId}`;
}
