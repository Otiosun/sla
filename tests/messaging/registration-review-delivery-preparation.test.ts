import { describe, expect, it, vi } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import { RegistrationReviewDeliveryPreparation } from "../../src/platform/registration/registration-review-delivery-preparation.js";

function outbox(payload: Readonly<Record<string, unknown>>): PendingOutboxMessage {
  return {
    id: "00000000-0000-4000-8000-000000000911",
    channel: "whatsapp",
    destinationRef: "120363000000000001@g.us",
    messageType: "TEXT",
    payload,
    idempotencyKey: "registration-review:911",
    correlationId: "00000000-0000-4000-8000-000000000912",
    causationId: null,
    attempts: 1,
  };
}

describe("RegistrationReviewDeliveryPreparation", () => {
  it("records the exact review anchor using the deterministic provider message id", async () => {
    const record = vi.fn(async () => {});
    const preparation = new RegistrationReviewDeliveryPreparation({
      provider: "baileys",
      messageRefs: { record },
      providerMessageIdFor: () => "00000000000040008000000000000911",
    });
    const message = outbox({
      text: "Nova ficha aguardando revisão.",
      registrationReview: {
        reviewId: "00000000-0000-4000-8000-000000000913",
        reviewRevision: 4,
      },
    });

    await preparation.prepare(message);

    expect(record).toHaveBeenCalledWith({
      provider: "baileys",
      providerExternalMessageId: "00000000000040008000000000000911",
      outboxMessageId: message.id,
      reviewId: "00000000-0000-4000-8000-000000000913",
      reviewRevision: 4,
    });
  });

  it("ignores ordinary outbox messages but fails closed on malformed review anchors", async () => {
    const record = vi.fn(async () => {});
    const preparation = new RegistrationReviewDeliveryPreparation({
      provider: "baileys",
      messageRefs: { record },
      providerMessageIdFor: () => "provider-id",
    });

    await preparation.prepare(outbox({ text: "Mensagem comum" }));
    expect(record).not.toHaveBeenCalled();

    await expect(
      preparation.prepare(
        outbox({
          text: "Marcador quebrado",
          registrationReview: { reviewId: "", reviewRevision: -1 },
        }),
      ),
    ).rejects.toThrow("Invalid registration review delivery anchor");
    expect(record).not.toHaveBeenCalled();
  });
});
