import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { EconomyService } from "../../src/modules/economy/service.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
} from "../../src/modules/messaging/contracts.js";
import type { MessageRouteHandler } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  MessagingService,
  type MessagingRateLimitPolicySet,
} from "../../src/modules/messaging/service.js";
import { withTransaction } from "../../src/platform/db/transaction.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { parsePlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { ok } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 16 messaging concurrency proof");
}

const rateLimitPolicy: MessagingRateLimitPolicySet = {
  player: { policyKey: "phase16.concurrency.player", maxEvents: 1_000, windowMs: 60_000 },
  chat: { policyKey: "phase16.concurrency.chat", maxEvents: 1_000, windowMs: 60_000 },
  sensitiveAction: {
    policyKey: "phase16.concurrency.action",
    maxEvents: 1_000,
    windowMs: 60_000,
  },
};

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error(`Invalid Phase 16 proof PlayerId: ${value}`);
  return parsed.value;
}

function message(input: {
  readonly id: string;
  readonly sender: string;
  readonly chat: string;
  readonly text: string;
}): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "phase16-concurrency",
    externalMessageId: input.id,
    senderRef: input.sender,
    chatRef: input.chat,
    occurredAt: "2026-08-28T19:42:00-03:00",
    text: input.text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function createPlayerFixture(
  pool: Pool,
  sender: string,
): Promise<{ readonly playerId: string; readonly currencyId: string }> {
  const proofPlayerId = randomUUID();
  const identityId = randomUUID();
  const currencyId = randomUUID();
  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [proofPlayerId]);
  await pool.query(
    `INSERT INTO player_identities(id, player_id, provider, external_id, status)
     VALUES ($1, $2, 'phase16-concurrency', $3, 'ACTIVE')`,
    [identityId, proofPlayerId, sender],
  );
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Phase 16 Concurrency Coin', FALSE)`,
    [currencyId, `phase16-concurrency-${proofPlayerId}`],
  );
  return { playerId: proofPlayerId, currencyId };
}

async function walletState(
  pool: Pool,
  proofPlayerId: string,
  currencyId: string,
): Promise<{ readonly amount: string; readonly ledgers: string }> {
  const result = await pool.query<{ amount: string; ledgers: string }>(
    `SELECT
       COALESCE((SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2), '0') AS amount,
       (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledgers`,
    [proofPlayerId, currencyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Wallet proof state query returned no row");
  return row;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 24 });
  try {
    const repository = new PostgresMessagingRepository(pool);
    const economy = new EconomyService(new PostgresEconomyRepository(pool));

    // 16.1 — duplicate-message storm: one external message is delivered concurrently many times.
    const stormFixture = await createPlayerFixture(pool, "storm-player");
    const stormHandler: MessageRouteHandler = {
      async handle(context) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        const credited = await economy.creditWallet({
          playerId: playerId(stormFixture.playerId),
          currencyId: stormFixture.currencyId,
          amount: 5n,
          idempotencyKey: context.idempotencyKey,
          metadata: {
            sourceType: "WHATSAPP_MESSAGE",
            sourceId: context.inboxMessageId,
            reason: "Phase 16 duplicate-message storm proof",
            actorType: "PLAYER",
            actorId: stormFixture.playerId,
            correlationId: context.correlationId,
          },
        });
        if (!credited.ok) return credited;
        return ok({
          resultRefType: "WALLET_LEDGER",
          resultRefId: credited.value.ledgerId,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: { text: "storm-accepted" },
              idempotencyKey: `phase16.storm.reply:${context.inboxMessageId}`,
            },
          ],
        });
      },
    };
    const stormService = new MessagingService(
      repository,
      new MessageRouter([{ command: "storm", handler: stormHandler }]),
      30_000,
      rateLimitPolicy,
    );
    const stormMessage = message({
      id: "duplicate-storm-1",
      sender: "storm-player",
      chat: "storm-chat",
      text: "$storm",
    });
    const stormResults = await Promise.all(
      Array.from({ length: 48 }, () => stormService.receive(stormMessage)),
    );
    if (stormResults.some((result) => !result.ok)) {
      throw new Error("Duplicate-message storm returned an application error");
    }
    const stormStatuses = stormResults.map((result) => (result.ok ? result.value.status : "ERROR"));
    const processedCount = stormStatuses.filter((status) => status === "PROCESSED").length;
    const passiveCount = stormStatuses.filter(
      (status) => status === "IN_FLIGHT" || status === "REPLAYED",
    ).length;
    if (processedCount !== 1 || passiveCount !== 47) {
      throw new Error(`Duplicate-message storm ownership mismatch: ${JSON.stringify(stormStatuses)}`);
    }
    const stormReplay = await stormService.receive(stormMessage);
    if (!stormReplay.ok || stormReplay.value.status !== "REPLAYED") {
      throw new Error(`Duplicate-message storm did not converge to replay: ${JSON.stringify(stormReplay)}`);
    }
    const stormEvidence = await pool.query<{
      inbox_count: string;
      amount: string;
      ledger_count: string;
      outbox_count: string;
      rate_charge_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM inbox_messages WHERE provider = 'phase16-concurrency' AND external_message_id = 'duplicate-storm-1') AS inbox_count,
         COALESCE((SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2), '0') AS amount,
         (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledger_count,
         (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key LIKE 'phase16.storm.reply:%') AS outbox_count,
         (SELECT count(*)::text FROM messaging_rate_limit_charges c JOIN inbox_messages i ON i.id = c.inbox_message_id WHERE i.provider = 'phase16-concurrency' AND i.external_message_id = 'duplicate-storm-1') AS rate_charge_count`,
      [stormFixture.playerId, stormFixture.currencyId],
    );
    const stormRow = stormEvidence.rows[0];
    if (
      stormRow?.inbox_count !== "1" ||
      stormRow.amount !== "5" ||
      stormRow.ledger_count !== "1" ||
      stormRow.outbox_count !== "1" ||
      stormRow.rate_charge_count !== "2"
    ) {
      throw new Error(`Duplicate-message storm duplicated state: ${JSON.stringify(stormRow)}`);
    }

    // 16.2 — distinct simultaneous commands from the same player must not lose or duplicate updates.
    const simultaneousFixture = await createPlayerFixture(pool, "simultaneous-player");
    const simultaneousHandler: MessageRouteHandler = {
      async handle(context) {
        const credited = await economy.creditWallet({
          playerId: playerId(simultaneousFixture.playerId),
          currencyId: simultaneousFixture.currencyId,
          amount: 1n,
          idempotencyKey: context.idempotencyKey,
          metadata: {
            sourceType: "WHATSAPP_MESSAGE",
            sourceId: context.inboxMessageId,
            reason: "Phase 16 same-player simultaneous command proof",
            actorType: "PLAYER",
            actorId: simultaneousFixture.playerId,
            correlationId: context.correlationId,
          },
        });
        if (!credited.ok) return credited;
        return ok({ resultRefType: "WALLET_LEDGER", resultRefId: credited.value.ledgerId, outgoing: [] });
      },
    };
    const simultaneousService = new MessagingService(
      repository,
      new MessageRouter([{ command: "simultaneous", handler: simultaneousHandler }]),
      30_000,
      rateLimitPolicy,
    );
    const simultaneousMessages = Array.from({ length: 24 }, (_, index) =>
      message({
        id: `simultaneous-${index + 1}`,
        sender: "simultaneous-player",
        chat: "simultaneous-chat",
        text: "$simultaneous",
      }),
    );
    const simultaneousResults = await Promise.all(
      simultaneousMessages.map((incoming) => simultaneousService.receive(incoming)),
    );
    if (
      simultaneousResults.some(
        (result) => !result.ok || result.value.status !== "PROCESSED",
      )
    ) {
      throw new Error(`Same-player simultaneous commands failed: ${JSON.stringify(simultaneousResults)}`);
    }
    const simultaneousState = await walletState(
      pool,
      simultaneousFixture.playerId,
      simultaneousFixture.currencyId,
    );
    const simultaneousInbox = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM inbox_messages
       WHERE provider = 'phase16-concurrency' AND external_message_id LIKE 'simultaneous-%'`,
    );
    if (
      simultaneousState.amount !== "24" ||
      simultaneousState.ledgers !== "24" ||
      simultaneousInbox.rows[0]?.count !== "24"
    ) {
      throw new Error(
        `Same-player simultaneous commands lost/duplicated state: ${JSON.stringify({ simultaneousState, inbox: simultaneousInbox.rows[0] })}`,
      );
    }

    // 16.4 — a process failure before COMMIT must leave no partial mechanical state.
    const preCommitFixture = await createPlayerFixture(pool, "precommit-player");
    let preCommitAttempts = 0;
    const preCommitHandler: MessageRouteHandler = {
      async handle(context) {
        preCommitAttempts += 1;
        await withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO wallet_balances(player_id, currency_id, amount, revision, updated_at)
             VALUES ($1, $2, 13, 0, now())
             ON CONFLICT (player_id, currency_id)
             DO UPDATE SET amount = wallet_balances.amount + 13,
                           revision = wallet_balances.revision + 1,
                           updated_at = now()`,
            [preCommitFixture.playerId, preCommitFixture.currencyId],
          );
          if (preCommitAttempts === 1) {
            throw new Error("simulated process failure before transaction commit");
          }
        });
        return ok({
          resultRefType: "PHASE16_PRECOMMIT_PROOF",
          resultRefId: context.inboxMessageId,
          outgoing: [],
        });
      },
    };
    const preCommitMessage = message({
      id: "precommit-crash-1",
      sender: "precommit-player",
      chat: "precommit-chat",
      text: "$precommit",
    });
    const preCommitService = new MessagingService(
      repository,
      new MessageRouter([{ command: "precommit", handler: preCommitHandler }]),
      30_000,
      rateLimitPolicy,
    );
    const preCommitFailure = await preCommitService.receive(preCommitMessage);
    if (preCommitFailure.ok || preCommitFailure.error.code !== "ACTION_INVALID") {
      throw new Error(`Pre-commit failure was not surfaced safely: ${JSON.stringify(preCommitFailure)}`);
    }
    const afterPreCommitFailure = await walletState(
      pool,
      preCommitFixture.playerId,
      preCommitFixture.currencyId,
    );
    if (afterPreCommitFailure.amount !== "0" || afterPreCommitFailure.ledgers !== "0") {
      throw new Error(
        `Pre-commit failure leaked partial state: ${JSON.stringify(afterPreCommitFailure)}`,
      );
    }
    const restartedPreCommitService = new MessagingService(
      new PostgresMessagingRepository(pool),
      new MessageRouter([{ command: "precommit", handler: preCommitHandler }]),
      30_000,
      rateLimitPolicy,
    );
    const preCommitRecovered = await restartedPreCommitService.receive(preCommitMessage);
    if (!preCommitRecovered.ok || preCommitRecovered.value.status !== "PROCESSED") {
      throw new Error(`Pre-commit retry did not recover: ${JSON.stringify(preCommitRecovered)}`);
    }
    const afterPreCommitRecovery = await walletState(
      pool,
      preCommitFixture.playerId,
      preCommitFixture.currencyId,
    );
    if (afterPreCommitRecovery.amount !== "13" || afterPreCommitRecovery.ledgers !== "0") {
      throw new Error(
        `Pre-commit retry did not commit exactly once: ${JSON.stringify(afterPreCommitRecovery)}`,
      );
    }
    const preCommitReplay = await restartedPreCommitService.receive(preCommitMessage);
    if (!preCommitReplay.ok || preCommitReplay.value.status !== "REPLAYED") {
      throw new Error(`Pre-commit recovery did not become replay-safe: ${JSON.stringify(preCommitReplay)}`);
    }

    // 16.7 — real PostgreSQL statement timeout must abort and roll back the entire transaction.
    let timeoutCode: string | null = null;
    try {
      await withTransaction(pool, async (client) => {
        await client.query("SET LOCAL statement_timeout = '50ms'");
        await client.query(
          `UPDATE wallet_balances
           SET amount = amount + 17, revision = revision + 1, updated_at = now()
           WHERE player_id = $1 AND currency_id = $2`,
          [preCommitFixture.playerId, preCommitFixture.currencyId],
        );
        await client.query("SELECT pg_sleep(0.20)");
      });
    } catch (error) {
      timeoutCode = postgresCode(error);
    }
    if (timeoutCode !== "57014") {
      throw new Error(`Expected PostgreSQL statement_timeout SQLSTATE 57014, got ${timeoutCode}`);
    }
    const afterTimeout = await walletState(pool, preCommitFixture.playerId, preCommitFixture.currencyId);
    if (afterTimeout.amount !== "13" || afterTimeout.ledgers !== "0") {
      throw new Error(`DB timeout leaked partial state: ${JSON.stringify(afterTimeout)}`);
    }

    console.log(
      "Phase 16 messaging concurrency/fault E2E complete: duplicate storm, same-player concurrency, pre-commit crash and DB timeout are safe",
    );
  } finally {
    await pool.end();
  }
}

await main();
