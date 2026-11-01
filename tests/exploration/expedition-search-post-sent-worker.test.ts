import { describe, expect, it } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type {
  MessagingRepository,
  OutboundMessageAdapter,
} from "../../src/modules/messaging/ports.js";
import { OutboxWorker } from "../../src/modules/messaging/service.js";
import { ExpeditionSearchPostSentHook } from "../../src/modules/exploration/expedition-search-post-sent-hook.js";
import { PostgresExpeditionPostSentRecovery } from "../../src/platform/exploration/postgres-expedition-post-sent-recovery.js";
import { err, appError, ok } from "../../src/shared-kernel/result.js";

const playerId = "00000000-0000-4000-8000-000000000121";
const encounterId = "00000000-0000-4000-8000-000000000122";
const outcomeId = "00000000-0000-4000-8000-000000000123";
const message: PendingOutboxMessage = {
  id: "00000000-0000-4000-8000-000000000124",
  channel: "whatsapp",
  destinationRef: "5579999999999@s.whatsapp.net",
  messageType: "TEXT",
  payload: {
    text: "Synthetic staging result",
    expeditionSearch: { playerId, encounterId, outcomeId },
  },
  idempotencyKey: "staging-outbox-proof",
  correlationId: "00000000-0000-4000-8000-000000000125",
  causationId: null,
  attempts: 1,
};

function makeHook(engageAfterSent: (input: unknown) => Promise<unknown>, failures: string[]) {
  return new ExpeditionSearchPostSentHook(
    { engageAfterSent } as unknown as ConstructorParameters<typeof ExpeditionSearchPostSentHook>[0],
    (input) => failures.push(input.errorCode),
  );
}

function harness(input: {
  hook?: ConstructorParameters<typeof OutboxWorker>[4];
  outbound?: PendingOutboxMessage;
  failSend?: boolean;
  failMarkSent?: boolean;
}) {
  const events: string[] = [];
  const repository = {
    async claimOutbox() {
      return [input.outbound ?? message];
    },
    async markOutboxSent() {
      events.push("SENT");
      if (input.failMarkSent) throw new Error("mark failed");
    },
    async markOutboxFailed() {
      events.push("FAILED");
    },
  } as unknown as MessagingRepository;
  const adapter: OutboundMessageAdapter = {
    channel: "whatsapp",
    async send() {
      events.push("SEND");
      if (input.failSend) throw new Error("provider failure");
      return { providerExternalMessageId: "stage-only-message-id" };
    },
  };
  const worker = new OutboxWorker(
    repository,
    [adapter],
    {
      batchSize: 1,
      staleAfterMs: 30_000,
      maxAttempts: 8,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
    },
    undefined,
    input.hook,
  );
  return { worker, events };
}

describe("staging exploration hook on the actual OutboxWorker", () => {
  it("never engages before adapter.send and durable markOutboxSent", async () => {
    const failures: string[] = [];
    const { worker, events } = harness({
      hook: makeHook(async (input) => {
        events.push("ENGAGED");
        expect(input).toMatchObject({
          playerId,
          outcomeId,
          encounterId,
          outboxMessageId: message.id,
          destinationRef: message.destinationRef,
        });
        return ok({ encounterStatus: "ENGAGED" });
      }, failures),
    });
    expect(await worker.runOnce()).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      postSentFailed: 0,
    });
    expect(events).toEqual(["SEND", "SENT", "ENGAGED"]);
    expect(failures).toEqual([]);
  });

  it("does not install a post-SENT hook in the default worker", async () => {
    const { worker, events } = harness({});
    expect(await worker.runOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(events).toEqual(["SEND", "SENT"]);
  });

  it("never engages when send or SENT persistence failed", async () => {
    for (const flag of ["failSend", "failMarkSent"] as const) {
      const failures: string[] = [];
      const { worker, events } = harness({
        [flag]: true,
        hook: makeHook(async () => {
          events.push("ENGAGED");
          return ok({});
        }, failures),
      });
      expect(await worker.runOnce()).toMatchObject({
        claimed: 1,
        sent: 0,
        failed: 1,
      });
      expect(events).not.toContain("ENGAGED");
    }
  });

  it("does not resend after a domain callback failure on a SENT message", async () => {
    const failures: string[] = [];
    const { worker, events } = harness({
      hook: makeHook(async () => err(appError("FLOW_BLOCKED", "wrong owner")), failures),
    });
    expect(await worker.runOnce()).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      postSentFailed: 1,
    });
    expect(events).toEqual(["SEND", "SENT"]);
    expect(failures).toEqual(["EXPEDITION_POST_SENT_FLOW_BLOCKED"]);
  });

  it("rejects an invalid metadata anchor before any domain call", async () => {
    const failures: string[] = [];
    let engaged = 0;
    const { worker } = harness({
      outbound: {
        ...message,
        payload: { expeditionSearch: { playerId, outcomeId, encounterId: null } },
      },
      hook: makeHook(async () => {
        engaged += 1;
        return ok({});
      }, failures),
    });
    expect(await worker.runOnce()).toMatchObject({ sent: 1, postSentFailed: 1 });
    expect(engaged).toBe(0);
    expect(failures).toEqual(["EXPEDITION_POST_SENT_INVALID_ANCHOR"]);
  });

  it("is inert for ordinary messages without exploration anchors", async () => {
    const failures: string[] = [];
    const { worker } = harness({
      outbound: { ...message, payload: { text: "normal" } },
      hook: makeHook(async () => {
        throw new Error("must not engage");
      }, failures),
    });
    expect(await worker.runOnce()).toMatchObject({ sent: 1, postSentFailed: 0 });
    expect(failures).toEqual([]);
  });

  it("replays a durable SENT receipt without sending through any adapter", async () => {
    const failures: string[] = [];
    const calls: string[] = [];
    const hook = makeHook(async (input) => {
      calls.push("ENGAGED");
      expect(input).toMatchObject({ encounterId, outcomeId, playerId });
      return ok({ encounterStatus: "ENGAGED" });
    }, failures);
    const db = {
      async query() {
        return {
          rows: [
            {
              id: message.id,
              destination_ref: message.destinationRef,
              payload: message.payload,
              correlation_id: message.correlationId,
            },
          ],
        };
      },
    };
    const recovery = new PostgresExpeditionPostSentRecovery(
      db as unknown as ConstructorParameters<typeof PostgresExpeditionPostSentRecovery>[0],
      hook,
    );
    expect(await recovery.runOnce()).toEqual({ attempted: 1, engaged: 1, blocked: 0 });
    expect(calls).toEqual(["ENGAGED"]);
    expect(failures).toEqual([]);
    await expect(recovery.runOnce(101)).rejects.toThrow("bound");
  });
});
