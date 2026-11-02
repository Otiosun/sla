import { describe, expect, it } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type {
  MessagingRepository,
  OutboundMessageAdapter,
} from "../../src/modules/messaging/ports.js";
import { OutboxWorker } from "../../src/modules/messaging/service.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
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
  failPreparation?: boolean;
  failMarkSent?: boolean;
  quarantineUnknownDelivery?: boolean;
}) {
  const events: string[] = [];
  const failedCalls: Array<{ errorCode: string; retryAt: Date | null }> = [];
  const claimOptions: unknown[] = [];
  const repository = {
    async claimOutbox(options: unknown) {
      claimOptions.push(options);
      return [input.outbound ?? message];
    },
    async markOutboxSent() {
      events.push("SENT");
      if (input.failMarkSent) throw new Error("mark failed");
    },
    async markOutboxFailed(failure: { errorCode: string; retryAt: Date | null }) {
      events.push("FAILED");
      failedCalls.push(failure);
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
      ...(input.quarantineUnknownDelivery ? { quarantineUnknownDelivery: true } : {}),
    },
    input.failPreparation
      ? {
          async prepare() {
            throw new Error("preparation rejected");
          },
        }
      : undefined,
    input.hook,
  );
  return { worker, events, failedCalls, claimOptions };
}

describe("staging exploration hook on the actual OutboxWorker", () => {
  it("issues an immutable menu only AFTER canonical engagement of an actual SENT source", async () => {
    const events: string[] = [];
    const failures: string[] = [];
    const hook = new ExpeditionSearchPostSentHook(
      {
        engageAfterSent: async () => {
          events.push("ENGAGED");
          return ok({ encounterRevision: 2n });
        },
      } as never,
      ({ errorCode }) => failures.push(errorCode),
      {
        issue: async (input: {
          playerId: string;
          outcomeId: string;
          encounterId: string;
          expectedEncounterRevision: bigint;
          correlationId: string;
          destinationRef: string;
        }) => {
          events.push("MENU");
          expect(input).toMatchObject({
            playerId,
            encounterId,
            outcomeId,
            expectedEncounterRevision: 2n,
            correlationId: message.correlationId,
            destinationRef: message.destinationRef,
          });
          return ok({ menuId: "menu", outboxMessageId: "out", replayed: false });
        },
      } as never,
    );
    const { worker } = harness({ hook });
    expect(await worker.runOnce()).toMatchObject({ sent: 1, postSentFailed: 0 });
    expect(events).toEqual(["ENGAGED", "MENU"]);
    expect(failures).toEqual([]);

    await hook.afterSent({
      ...message,
      payload: {
        ...message.payload,
        expeditionMenu: { menuId: "menu", mode: "ACTIONABLE" },
      },
    });
    expect(events).toEqual(["ENGAGED", "MENU"]);
  });

  it("never issues the menu if engagement was denied, and does not resend SENT", async () => {
    let menus = 0;
    const errors: string[] = [];
    const hook = new ExpeditionSearchPostSentHook(
      { engageAfterSent: async () => err(appError("FLOW_BLOCKED", "stale")) } as never,
      ({ errorCode }) => errors.push(errorCode),
      {
        issue: async () => {
          menus++;
          return ok({});
        },
      } as never,
    );
    const { worker } = harness({ hook });
    expect(await worker.runOnce()).toMatchObject({ sent: 1, failed: 0, postSentFailed: 1 });
    expect(menus).toBe(0);
    expect(errors).toEqual(["EXPEDITION_POST_SENT_FLOW_BLOCKED"]);
  });

  it("recovers an ENGAGED search with no menu, excluding menu Outbox and any issued snapshot", async () => {
    const invoked: string[] = [];
    const database = {
      query: async (sql: string, args: unknown[]) => {
        expect(sql).toContain("'ENGAGED'");
        expect(sql).toContain("NOT EXISTS");
        expect(sql).toContain("solo_incidental_menu_snapshots");
        expect(sql).toContain("NOT (o.payload ? 'expeditionMenu')");
        expect(args).toEqual([25]);
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
    const recovery = new PostgresExpeditionPostSentRecovery(database as never, {
      async afterSent(replayed) {
        invoked.push(replayed.id);
      },
      onFailure() {
        throw new Error("No failure expected");
      },
    });
    expect(await recovery.runOnce()).toEqual({ attempted: 1, engaged: 1, blocked: 0 });
    expect(invoked).toEqual([message.id]);
  });

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

  it("quarantines a provider-accepted message when SENT persistence is uncertain", async () => {
    const { worker, events, failedCalls, claimOptions } = harness({
      failMarkSent: true,
      quarantineUnknownDelivery: true,
    });
    expect(await worker.runOnce()).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(events).toEqual(["SEND", "SENT", "FAILED"]);
    expect(failedCalls).toMatchObject([
      { errorCode: "OUTBOX_SENT_PERSISTENCE_UNCONFIRMED", retryAt: null },
    ]);
    expect(claimOptions).toMatchObject([{ quarantineStaleSending: true }]);
  });

  it("quarantines a rejected provider call whose delivery outcome is unknown", async () => {
    const { worker, failedCalls } = harness({
      failSend: true,
      quarantineUnknownDelivery: true,
    });
    expect(await worker.runOnce()).toMatchObject({ sent: 0, failed: 1 });
    expect(failedCalls[0]?.errorCode).toBe("OUTBOX_TRANSPORT_OUTCOME_UNKNOWN");
    expect(failedCalls[0]?.retryAt).toBeNull();
  });

  it("retries a preparation failure before any provider send attempt", async () => {
    const { worker, events, failedCalls } = harness({
      failPreparation: true,
      quarantineUnknownDelivery: true,
    });
    expect(await worker.runOnce()).toMatchObject({ sent: 0, failed: 1 });
    expect(events).toEqual(["FAILED"]);
    expect(failedCalls[0]?.errorCode).toBe("OUTBOX_DELIVERY_FAILED");
    expect(failedCalls[0]?.retryAt).toBeInstanceOf(Date);
  });

  it("rejects a SENT transition that updated zero sending rows", async () => {
    const repo = new PostgresMessagingRepository({
      async query() {
        return { rowCount: 0 };
      },
    } as unknown as ConstructorParameters<typeof PostgresMessagingRepository>[0]);
    await expect(repo.markOutboxSent(message.id)).rejects.toThrow("lost its sending claim");
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
