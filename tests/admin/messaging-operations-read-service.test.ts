import { describe, expect, it, vi } from "vitest";
import { MessagingOperationsReadService } from "../../src/modules/admin/messaging-operations-read-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

const evidence = {
  inbox: {
    counts: { RECEIVED: 1, PROCESSING: 2, PROCESSED: 3, FAILED: 4 },
    recent: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        status: "FAILED" as const,
        attempts: 2,
        receivedAt: new Date("2026-09-01T12:00:00.000Z"),
        processedAt: null,
        processingStartedAt: new Date("2026-09-01T12:00:05.000Z"),
      },
    ],
  },
  outbox: {
    counts: { PENDING: 5, SENDING: 1, SENT: 20, FAILED: 2, DEAD: 1 },
    recent: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        status: "SENDING" as const,
        attempts: 1,
        nextAttemptAt: new Date("2026-09-01T12:01:00.000Z"),
        createdAt: new Date("2026-09-01T12:00:30.000Z"),
        sentAt: null,
        sendingStartedAt: new Date("2026-09-01T12:00:40.000Z"),
      },
    ],
    deadLetter: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        status: "DEAD" as const,
        attempts: 8,
        nextAttemptAt: null,
        createdAt: new Date("2026-09-01T11:00:00.000Z"),
        sentAt: null,
        sendingStartedAt: null,
      },
    ],
  },
};

describe("MessagingOperationsReadService", () => {
  it("authorizes a global messaging read and returns only metadata with canonical timestamps", async () => {
    const authorizeRead = vi.fn(async () => ({ type: "RUNTIME", id: null }));
    const readSnapshot = vi.fn(async () => evidence);
    const service = new MessagingOperationsReadService({ authorizeRead }, { readSnapshot });

    const result = await service.getSnapshot({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
    });

    expect(authorizeRead).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "messaging.operations.read",
      input: {},
      correlationId: CORRELATION_ID,
    });
    expect(readSnapshot).toHaveBeenCalledWith(25);
    expect(result).toEqual({
      inbox: {
        counts: evidence.inbox.counts,
        recent: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            status: "FAILED",
            attempts: 2,
            receivedAt: "2026-09-01T12:00:00.000Z",
            processedAt: null,
            processingStartedAt: "2026-09-01T12:00:05.000Z",
          },
        ],
      },
      outbox: {
        counts: evidence.outbox.counts,
        recent: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            status: "SENDING",
            attempts: 1,
            nextAttemptAt: "2026-09-01T12:01:00.000Z",
            createdAt: "2026-09-01T12:00:30.000Z",
            sentAt: null,
            sendingStartedAt: "2026-09-01T12:00:40.000Z",
          },
        ],
        deadLetter: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            status: "DEAD",
            attempts: 8,
            nextAttemptAt: null,
            createdAt: "2026-09-01T11:00:00.000Z",
            sentAt: null,
            sendingStartedAt: null,
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "normalized_payload",
      "payload",
      "destination_ref",
      "external_message_id",
      "provider_media_id",
      "last_error_code",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
