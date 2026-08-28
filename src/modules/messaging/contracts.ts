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
  })
  .strict();

export type OutgoingMessageDraft = z.infer<typeof OutgoingMessageDraftSchema>;

export interface MessageHandlerContext {
  readonly inboxMessageId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly message: IncomingMessage;
}

export interface MessageHandlerResult {
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly outgoing: readonly OutgoingMessageDraft[];
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

export function incomingMessageFingerprint(message: IncomingMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function incomingMessageIdempotencyKey(message: IncomingMessage): string {
  return `inbox:${message.provider}:${message.externalMessageId}`;
}
