import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboxDeliveryPreparation } from "../../modules/messaging/ports.js";

interface RegistrationReviewMessageRefWriter {
  record(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
    readonly outboxMessageId: string;
    readonly reviewId: string;
    readonly reviewRevision: number;
  }): Promise<void>;
}

export interface RegistrationReviewDeliveryPreparationOptions {
  readonly provider: string;
  readonly messageRefs: RegistrationReviewMessageRefWriter;
  readonly providerMessageIdFor: (message: PendingOutboxMessage) => string;
}

interface RegistrationReviewDeliveryAnchor {
  readonly reviewId: string;
  readonly reviewRevision: number;
}

function parseAnchor(value: unknown): RegistrationReviewDeliveryAnchor | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid registration review delivery anchor");
  }

  const reviewId = "reviewId" in value ? value.reviewId : undefined;
  const reviewRevision = "reviewRevision" in value ? value.reviewRevision : undefined;
  if (
    typeof reviewId !== "string" ||
    reviewId.trim().length === 0 ||
    typeof reviewRevision !== "number" ||
    !Number.isSafeInteger(reviewRevision) ||
    reviewRevision < 0
  ) {
    throw new Error("Invalid registration review delivery anchor");
  }

  return { reviewId: reviewId.trim(), reviewRevision };
}

export class RegistrationReviewDeliveryPreparation implements OutboxDeliveryPreparation {
  private readonly provider: string;

  public constructor(private readonly options: RegistrationReviewDeliveryPreparationOptions) {
    this.provider = options.provider.trim();
    if (this.provider.length === 0) {
      throw new Error("Registration review delivery provider is required");
    }
  }

  public async prepare(message: PendingOutboxMessage): Promise<void> {
    if (message.channel !== "whatsapp") return;

    const anchor = parseAnchor(message.payload.registrationReview);
    if (anchor === null) return;

    const providerExternalMessageId = this.options.providerMessageIdFor(message).trim();
    if (providerExternalMessageId.length === 0) {
      throw new Error("Registration review provider message id is required");
    }

    await this.options.messageRefs.record({
      provider: this.provider,
      providerExternalMessageId,
      outboxMessageId: message.id,
      reviewId: anchor.reviewId,
      reviewRevision: anchor.reviewRevision,
    });
  }
}
