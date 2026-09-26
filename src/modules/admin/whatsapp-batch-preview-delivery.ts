import type { PendingOutboxMessage } from "../messaging/contracts.js";
import type { OutboxDeliveryPreparation } from "../messaging/ports.js";

interface AdminBatchPreviewRefWriter {
  record(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
    readonly outboxMessageId: string;
    readonly adminPrincipalId: string;
    readonly chatRef: string;
    readonly batchId: string;
    readonly batchRevision: string;
  }): Promise<void>;
}

interface AdminBatchPreviewAnchor {
  readonly adminPrincipalId: string;
  readonly batchId: string;
  readonly batchRevision: string;
}

function parseAnchor(value: unknown): AdminBatchPreviewAnchor | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid admin batch preview delivery anchor");
  }
  const adminPrincipalId =
    "adminPrincipalId" in value && typeof value.adminPrincipalId === "string"
      ? value.adminPrincipalId
      : null;
  const batchId = "batchId" in value && typeof value.batchId === "string" ? value.batchId : null;
  const batchRevision =
    "batchRevision" in value && typeof value.batchRevision === "string"
      ? value.batchRevision
      : null;
  if (
    adminPrincipalId === null ||
    batchId === null ||
    batchRevision === null ||
    !/^\d+$/.test(batchRevision)
  ) {
    throw new Error("Invalid admin batch preview delivery anchor");
  }
  return { adminPrincipalId, batchId, batchRevision };
}

export class AdminBatchWhatsAppPreviewDeliveryPreparation implements OutboxDeliveryPreparation {
  public constructor(
    private readonly options: {
      readonly provider: string;
      readonly refs: AdminBatchPreviewRefWriter;
      readonly providerMessageIdFor: (message: PendingOutboxMessage) => string;
    },
  ) {}

  public async prepare(message: PendingOutboxMessage): Promise<void> {
    if (message.channel !== "whatsapp") return;
    const anchor = parseAnchor(message.payload.adminBatchPreview);
    if (anchor === null) return;
    const providerExternalMessageId = this.options.providerMessageIdFor(message).trim();
    if (providerExternalMessageId.length === 0) {
      throw new Error("Admin batch preview provider message id is required");
    }
    await this.options.refs.record({
      provider: this.options.provider,
      providerExternalMessageId,
      outboxMessageId: message.id,
      adminPrincipalId: anchor.adminPrincipalId,
      chatRef: message.destinationRef,
      batchId: anchor.batchId,
      batchRevision: anchor.batchRevision,
    });
  }
}
