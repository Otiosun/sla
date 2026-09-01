import type {
  MessagingInboxMetadataEvidence,
  MessagingInboxMetadataView,
  MessagingOperationsReadRepository,
  MessagingOperationsView,
  MessagingOutboxMetadataEvidence,
  MessagingOutboxMetadataView,
} from "./messaging-operations-read-contracts.js";

interface MessagingOperationsReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface MessagingOperationsReadRequest {
  readonly principalId: string;
  readonly correlationId: string;
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function inboxView(evidence: MessagingInboxMetadataEvidence): MessagingInboxMetadataView {
  return {
    id: evidence.id,
    status: evidence.status,
    attempts: evidence.attempts,
    receivedAt: evidence.receivedAt.toISOString(),
    processedAt: toIso(evidence.processedAt),
    processingStartedAt: toIso(evidence.processingStartedAt),
  };
}

function outboxView(evidence: MessagingOutboxMetadataEvidence): MessagingOutboxMetadataView {
  return {
    id: evidence.id,
    status: evidence.status,
    attempts: evidence.attempts,
    nextAttemptAt: toIso(evidence.nextAttemptAt),
    createdAt: evidence.createdAt.toISOString(),
    sentAt: toIso(evidence.sentAt),
    sendingStartedAt: toIso(evidence.sendingStartedAt),
  };
}

export class MessagingOperationsReadService {
  public constructor(
    private readonly authorizer: MessagingOperationsReadAuthorizer,
    private readonly repository: MessagingOperationsReadRepository,
  ) {}

  public async getSnapshot(
    request: MessagingOperationsReadRequest,
  ): Promise<MessagingOperationsView> {
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "messaging.operations.read",
      input: {},
      correlationId: request.correlationId,
    });

    const evidence = await this.repository.readSnapshot(25);
    return {
      inbox: {
        counts: evidence.inbox.counts,
        recent: evidence.inbox.recent.map(inboxView),
      },
      outbox: {
        counts: evidence.outbox.counts,
        recent: evidence.outbox.recent.map(outboxView),
        deadLetter: evidence.outbox.deadLetter.map(outboxView),
      },
    };
  }
}
