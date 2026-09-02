import { describe, expect, it } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type {
  MessagingRepository,
  OutboundMessageAdapter,
} from "../../src/modules/messaging/ports.js";
import { OutboxWorker } from "../../src/modules/messaging/service.js";

const message: PendingOutboxMessage = {
  id: "00000000-0000-4000-8000-000000000901",
  channel: "whatsapp",
  destinationRef: "120363000000000001@g.us",
  messageType: "TEXT",
  payload: { text: "Ficha para revisão" },
  idempotencyKey: "registration-review:901",
  correlationId: "00000000-0000-4000-8000-000000000902",
  causationId: null,
  attempts: 1,
};

function workerHarness(prepareShouldFail = false) {
  const events: string[] = [];
  const repository = {
    async claimOutbox() {
      return [message];
    },
    async markOutboxSent() {
      events.push("sent");
    },
    async markOutboxFailed() {
      events.push("failed");
    },
  } as unknown as MessagingRepository;
  const adapter: OutboundMessageAdapter = {
    channel: "whatsapp",
    async send() {
      events.push("send");
      return { providerExternalMessageId: "00000000000040008000000000000901" };
    },
  };
  const preparation = {
    async prepare() {
      events.push("prepare");
      if (prepareShouldFail) throw new Error("anchor persistence failed");
    },
  };
  const worker = Reflect.construct(OutboxWorker, [
    repository,
    [adapter],
    {
      batchSize: 10,
      staleAfterMs: 30_000,
      maxAttempts: 8,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
    },
    preparation,
  ]) as OutboxWorker;
  return { worker, events };
}

describe("OutboxWorker delivery preparation", () => {
  it("persists delivery preparation before provider send and marks SENT only afterward", async () => {
    const { worker, events } = workerHarness();

    expect(await worker.runOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(events).toEqual(["prepare", "send", "sent"]);
  });

  it("never calls the provider when delivery preparation fails", async () => {
    const { worker, events } = workerHarness(true);

    expect(await worker.runOnce()).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(events).toEqual(["prepare", "failed"]);
  });
});
