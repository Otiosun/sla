import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { FakeWhatsAppAdapter } from "../../src/adapters/whatsapp/fake-whatsapp-adapter.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
} from "../../src/modules/messaging/contracts.js";
import type { MessageRouteHandler } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { parsePlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 13 messaging foundation proof");
}

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error(`Invalid proof PlayerId: ${value}`);
  return parsed.value;
}

function message(input: {
  readonly id: string;
  readonly text: string;
  readonly occurredAt?: string;
}): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "phase13-fake",
    externalMessageId: input.id,
    senderRef: "player:phase13",
    chatRef: "chat:phase13",
    occurredAt: input.occurredAt ?? "2026-08-27T22:00:00-03:00",
    text: input.text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const proofPlayerId = randomUUID();
    const currencyId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [proofPlayerId]);
    await pool.query(
      `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
       VALUES ($1, $2, 'Phase 13 Coin', FALSE)`,
      [currencyId, `phase13-${proofPlayerId}`],
    );

    const economy = new EconomyService(new PostgresEconomyRepository(pool));
    const messagingRepository = new PostgresMessagingRepository(pool);
    const creditHandler: MessageRouteHandler = {
      async handle(context) {
        const credited = await economy.creditWallet({
          playerId: playerId(proofPlayerId),
          currencyId,
          amount: 10n,
          idempotencyKey: context.idempotencyKey,
          metadata: {
            sourceType: "WHATSAPP_MESSAGE",
            sourceId: context.inboxMessageId,
            reason: "Phase 13 messaging exactly-once proof",
            actorType: "PLAYER",
            actorId: proofPlayerId,
            correlationId: context.correlationId,
          },
        });
        if (!credited.ok) return credited;
        if (context.message.externalMessageId === "msg-crash" && !credited.value.replayed) {
          throw new Error("simulated process crash after owner commit");
        }
        return ok({
          resultRefType: "WALLET_LEDGER",
          resultRefId: credited.value.ledgerId,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: { text: `balance:${credited.value.amount.toString()}` },
              idempotencyKey: `phase13.reply:${context.inboxMessageId}`,
            },
          ],
        });
      },
    };
    const router = new MessageRouter([{ command: "credit", handler: creditHandler }]);
    const service = new MessagingService(messagingRepository, router, 30_000);

    const firstMessage = message({ id: "msg-1", text: "$credit" });
    const first = await service.receive(firstMessage);
    if (!first.ok || first.value.status !== "PROCESSED") {
      throw new Error(`Initial message did not process: ${JSON.stringify(first)}`);
    }
    const duplicate = await service.receive(firstMessage);
    if (!duplicate.ok || duplicate.value.status !== "REPLAYED") {
      throw new Error(`Duplicate message did not replay: ${JSON.stringify(duplicate)}`);
    }
    const drift = await service.receive({ ...firstMessage, text: "$credit changed" });
    if (drift.ok || drift.error.code !== "FINGERPRINT_MISMATCH") {
      throw new Error(`Message-id semantic drift was not rejected: ${JSON.stringify(drift)}`);
    }

    const freeform = await service.receive(
      message({
        id: "scene-1",
        text: "Charmander observa a trilha enquanto o narrador descreve a noite.",
      }),
    );
    if (!freeform.ok || freeform.value.status !== "PROCESSED") {
      throw new Error(
        `Freeform campaign scene was not safely ignored: ${JSON.stringify(freeform)}`,
      );
    }

    const crashMessage = message({ id: "msg-crash", text: "$credit" });
    const crashed = await service.receive(crashMessage);
    if (crashed.ok || crashed.error.code !== "ACTION_INVALID") {
      throw new Error(
        `Crash-window simulation did not fail the Inbox attempt: ${JSON.stringify(crashed)}`,
      );
    }
    const restartedService = new MessagingService(
      new PostgresMessagingRepository(pool),
      new MessageRouter([{ command: "credit", handler: creditHandler }]),
      30_000,
    );
    const recovered = await restartedService.receive(crashMessage);
    if (!recovered.ok || recovered.value.status !== "PROCESSED") {
      throw new Error(`Owner-commit restart did not converge: ${JSON.stringify(recovered)}`);
    }

    const staleMessage = message({ id: "msg-stale", text: "$credit" });
    const abandoned = await messagingRepository.claimIncoming(staleMessage, 30_000);
    if (!abandoned.ok || abandoned.value.status !== "CLAIMED") {
      throw new Error(`Could not create abandoned Inbox claim: ${JSON.stringify(abandoned)}`);
    }
    await pool.query(
      "UPDATE inbox_messages SET processing_started_at = now() - interval '2 minutes' WHERE id = $1",
      [abandoned.value.inboxMessageId],
    );
    const staleRecovered = await restartedService.receive(staleMessage);
    if (!staleRecovered.ok || staleRecovered.value.status !== "PROCESSED") {
      throw new Error(`Stale Inbox claim was not recoverable: ${JSON.stringify(staleRecovered)}`);
    }

    const later = message({
      id: "msg-later",
      text: "$credit",
      occurredAt: "2026-08-27T22:02:00-03:00",
    });
    const earlier = message({
      id: "msg-earlier",
      text: "$credit",
      occurredAt: "2026-08-27T22:01:00-03:00",
    });
    const deliveredOutOfOrder = [
      await restartedService.receive(later),
      await restartedService.receive(earlier),
    ];
    if (deliveredOutOfOrder.some((result) => !result.ok || result.value.status !== "PROCESSED")) {
      throw new Error("Reordered distinct messages did not process independently");
    }

    const mechanicalState = await pool.query<{
      amount: string;
      ledger_count: string;
      inbox_count: string;
      outbox_count: string;
      freeform_outbox_count: string;
    }>(
      `SELECT
         (SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2) AS amount,
         (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledger_count,
         (SELECT count(*)::text FROM inbox_messages WHERE provider = 'phase13-fake') AS inbox_count,
         (SELECT count(*)::text FROM outbox_messages WHERE channel = 'whatsapp' AND destination_ref = 'chat:phase13') AS outbox_count,
         (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key LIKE 'phase13.reply:%' AND payload->>'text' IS NULL) AS freeform_outbox_count`,
      [proofPlayerId, currencyId],
    );
    const state = mechanicalState.rows[0];
    if (
      state === undefined ||
      state.amount !== "50" ||
      state.ledger_count !== "5" ||
      state.inbox_count !== "6" ||
      state.outbox_count !== "5" ||
      state.freeform_outbox_count !== "0"
    ) {
      throw new Error(`Messaging exactly-once state mismatch: ${JSON.stringify(state)}`);
    }

    const adapter = new FakeWhatsAppAdapter();
    const worker = new OutboxWorker(messagingRepository, [adapter], {
      batchSize: 1,
      staleAfterMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    adapter.failNext();
    const failedDelivery = await worker.runOnce();
    if (failedDelivery.failed !== 1 || adapter.sent.length !== 0) {
      throw new Error(`Delivery failure was not isolated: ${JSON.stringify(failedDelivery)}`);
    }
    const balanceAfterDeliveryFailure = await pool.query<{ amount: string; ledger_count: string }>(
      `SELECT
         (SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2) AS amount,
         (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledger_count`,
      [proofPlayerId, currencyId],
    );
    if (
      balanceAfterDeliveryFailure.rows[0]?.amount !== "50" ||
      balanceAfterDeliveryFailure.rows[0]?.ledger_count !== "5"
    ) {
      throw new Error("Outbox delivery failure repeated mechanical state");
    }

    await worker.runOnce();
    const concurrentWorker = new OutboxWorker(messagingRepository, [adapter], {
      batchSize: 10,
      staleAfterMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    await Promise.all([concurrentWorker.runOnce(), concurrentWorker.runOnce()]);
    if (adapter.sent.length !== 5) {
      throw new Error(
        `Concurrent Outbox workers duplicated or lost delivery: ${adapter.sent.length}`,
      );
    }

    const stuckOutboxId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status,
         attempts, next_attempt_at, correlation_id, causation_id, sending_started_at
       ) VALUES ($1, 'whatsapp', 'chat:phase13', 'TEXT', '{"text":"stuck"}'::jsonb, $2,
                 'SENDING', 1, NULL, $3, NULL, now() - interval '2 minutes')`,
      [stuckOutboxId, `phase13.stuck:${stuckOutboxId}`, randomUUID()],
    );
    await concurrentWorker.runOnce();
    const recoveredOutbox = await pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM outbox_messages WHERE id = $1",
      [stuckOutboxId],
    );
    if (recoveredOutbox.rows[0]?.status !== "SENT" || recoveredOutbox.rows[0]?.attempts !== 2) {
      throw new Error(
        `Stuck SENDING row did not recover: ${JSON.stringify(recoveredOutbox.rows[0])}`,
      );
    }

    const deadOutboxId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status,
         attempts, next_attempt_at, correlation_id, causation_id
       ) VALUES ($1, 'whatsapp', 'chat:phase13', 'TEXT', '{"text":"dead"}'::jsonb, $2,
                 'PENDING', 0, now(), $3, NULL)`,
      [deadOutboxId, `phase13.dead:${deadOutboxId}`, randomUUID()],
    );
    const deadWorker = new OutboxWorker(messagingRepository, [adapter], {
      batchSize: 1,
      staleAfterMs: 1_000,
      maxAttempts: 2,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    adapter.failNext(2);
    await deadWorker.runOnce();
    await deadWorker.runOnce();
    const dead = await pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM outbox_messages WHERE id = $1",
      [deadOutboxId],
    );
    if (dead.rows[0]?.status !== "DEAD" || dead.rows[0]?.attempts !== 2) {
      throw new Error(
        `Outbox did not dead-letter at the configured limit: ${JSON.stringify(dead.rows[0])}`,
      );
    }

    console.log(
      "Phase 13 messaging foundation E2E complete: duplicate/reordered/restart/outbox retry are exactly-once safe",
    );
  } finally {
    await pool.end();
  }
}

await main();
