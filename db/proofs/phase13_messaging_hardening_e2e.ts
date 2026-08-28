import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { EconomyService } from "../../src/modules/economy/service.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
  type PendingMediaJob,
} from "../../src/modules/messaging/contracts.js";
import type {
  MediaProcessorAdapter,
  MessageRouteHandler,
} from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import {
  MediaWorker,
  MessagingService,
  type MessagingRateLimitPolicySet,
} from "../../src/modules/messaging/service.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { parsePlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 13 messaging hardening proof");
}

function playerId(value: string): PlayerId {
  const parsed = parsePlayerId(value);
  if (!parsed.ok) throw new Error(`Invalid proof PlayerId: ${value}`);
  return parsed.value;
}

function message(input: {
  readonly id: string;
  readonly sender: string;
  readonly chat: string;
  readonly text: string;
  readonly mediaRefs?: readonly {
    readonly providerMediaId: string;
    readonly kind: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "STICKER" | "OTHER";
    readonly mimeType?: string | null;
    readonly fileName?: string | null;
  }[];
}): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "phase13-hardening",
    externalMessageId: input.id,
    senderRef: input.sender,
    chatRef: input.chat,
    occurredAt: "2026-08-28T00:00:00-03:00",
    text: input.text,
    mediaRefs: input.mediaRefs ?? [],
    replyToExternalMessageId: null,
  });
}

function policy(input: {
  readonly key: string;
  readonly player: number;
  readonly chat: number;
  readonly sensitive: number;
}): MessagingRateLimitPolicySet {
  return {
    player: {
      policyKey: `${input.key}.player`,
      maxEvents: input.player,
      windowMs: 60_000,
    },
    chat: {
      policyKey: `${input.key}.chat`,
      maxEvents: input.chat,
      windowMs: 60_000,
    },
    sensitiveAction: {
      policyKey: `${input.key}.action`,
      maxEvents: input.sensitive,
      windowMs: 60_000,
    },
  };
}

const noopHandler: MessageRouteHandler = {
  async handle() {
    return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
  },
};

class ProofMediaProcessor implements MediaProcessorAdapter {
  readonly processorKey = "phase13-proof";
  readonly processed: PendingMediaJob[] = [];
  private failuresRemaining = 0;

  failNext(count = 1): void {
    this.failuresRemaining += count;
  }

  async process(job: PendingMediaJob): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("simulated optional media failure");
    }
    this.processed.push(job);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const repository = new PostgresMessagingRepository(pool);
    const registeredPlayerId = randomUUID();
    const identityId = randomUUID();
    const currencyId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [registeredPlayerId]);
    await pool.query(
      `INSERT INTO player_identities(id, player_id, provider, external_id, status)
       VALUES ($1, $2, 'phase13-hardening', 'registered-player', 'ACTIVE')`,
      [identityId, registeredPlayerId],
    );
    await pool.query(
      `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
       VALUES ($1, $2, 'Phase 13 Hardening Coin', FALSE)`,
      [currencyId, `phase13-hardening-${registeredPlayerId}`],
    );

    const playerLimiter = new MessagingService(
      repository,
      new MessageRouter(),
      30_000,
      policy({ key: "proof.player", player: 1, chat: 100, sensitive: 100 }),
    );
    const playerFirstMessage = message({
      id: "player-limit-1",
      sender: "registered-player",
      chat: "player-limit-chat",
      text: "cena livre 1",
    });
    const playerSecondMessage = message({
      id: "player-limit-2",
      sender: "registered-player",
      chat: "player-limit-chat",
      text: "cena livre 2",
    });
    const playerFirst = await playerLimiter.receive(playerFirstMessage);
    const playerSecond = await playerLimiter.receive(playerSecondMessage);
    const playerSecondReplay = await playerLimiter.receive(playerSecondMessage);
    if (
      !playerFirst.ok ||
      playerFirst.value.status !== "PROCESSED" ||
      !playerSecond.ok ||
      playerSecond.value.status !== "PROCESSED" ||
      playerSecond.value.resultRefType !== "MESSAGING_ERROR" ||
      !playerSecondReplay.ok ||
      playerSecondReplay.value.status !== "REPLAYED"
    ) {
      throw new Error("PLAYER rate limiting did not process/replay deterministically");
    }

    const playerEvidence = await pool.query<{
      player_id: string | null;
      charge_count: string;
      player_bucket_used: number;
      raw_subject_count: string;
    }>(
      `SELECT
         (SELECT player_id::text FROM inbox_messages WHERE provider = 'phase13-hardening' AND external_message_id = 'player-limit-1') AS player_id,
         (SELECT count(*)::text FROM messaging_rate_limit_charges WHERE inbox_message_id = $1) AS charge_count,
         (SELECT used FROM messaging_rate_limit_buckets WHERE scope_kind = 'PLAYER' AND policy_key = 'proof.player.player') AS player_bucket_used,
         (SELECT count(*)::text FROM messaging_rate_limit_buckets WHERE subject_hash IN ('registered-player', 'player-limit-chat')) AS raw_subject_count`,
      [playerFirst.value.inboxMessageId],
    );
    const playerRow = playerEvidence.rows[0];
    if (
      playerRow?.player_id !== registeredPlayerId ||
      playerRow.charge_count !== "2" ||
      playerRow.player_bucket_used !== 1 ||
      playerRow.raw_subject_count !== "0"
    ) {
      throw new Error(`PLAYER rate-limit evidence mismatch: ${JSON.stringify(playerRow)}`);
    }

    const chatLimiter = new MessagingService(
      repository,
      new MessageRouter(),
      30_000,
      policy({ key: "proof.chat", player: 100, chat: 1, sensitive: 100 }),
    );
    const chatFirst = await chatLimiter.receive(
      message({ id: "chat-limit-1", sender: "chat-sender-a", chat: "shared-chat", text: "a" }),
    );
    const chatSecond = await chatLimiter.receive(
      message({ id: "chat-limit-2", sender: "chat-sender-b", chat: "shared-chat", text: "b" }),
    );
    if (
      !chatFirst.ok ||
      chatFirst.value.status !== "PROCESSED" ||
      !chatSecond.ok ||
      chatSecond.value.resultRefType !== "MESSAGING_ERROR"
    ) {
      throw new Error("CHAT rate limiting did not isolate a shared chat");
    }
    const chatSecondCharges = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messaging_rate_limit_charges WHERE inbox_message_id = $1",
      [chatSecond.value.inboxMessageId],
    );
    if (chatSecondCharges.rows[0]?.count !== "0") {
      throw new Error("Blocked CHAT message partially consumed another rate-limit bucket");
    }

    const actionRouter = new MessageRouter([
      { command: "sensitive", handler: noopHandler, rateLimitClass: "SENSITIVE" },
    ]);
    const actionLimiter = new MessagingService(
      repository,
      actionRouter,
      30_000,
      policy({ key: "proof.action", player: 100, chat: 100, sensitive: 1 }),
    );
    const actionFirst = await actionLimiter.receive(
      message({
        id: "action-limit-1",
        sender: "action-sender",
        chat: "action-chat",
        text: "$sensitive",
      }),
    );
    const actionSecond = await actionLimiter.receive(
      message({
        id: "action-limit-2",
        sender: "action-sender",
        chat: "action-chat",
        text: "$sensitive",
      }),
    );
    if (
      !actionFirst.ok ||
      actionFirst.value.status !== "PROCESSED" ||
      !actionSecond.ok ||
      actionSecond.value.resultRefType !== "MESSAGING_ERROR"
    ) {
      throw new Error("Sensitive ACTION rate limiting did not block the second action");
    }
    const actionCharges = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messaging_rate_limit_charges WHERE inbox_message_id = $1",
      [actionFirst.value.inboxMessageId],
    );
    if (actionCharges.rows[0]?.count !== "3") {
      throw new Error("Sensitive ACTION admission did not charge player/chat/action atomically");
    }

    let crashCalls = 0;
    const crashHandler: MessageRouteHandler = {
      async handle() {
        crashCalls += 1;
        if (crashCalls === 1) throw new Error("simulated crash after rate-limit admission");
        return ok({ resultRefType: null, resultRefId: null, outgoing: [] });
      },
    };
    const crashService = new MessagingService(
      repository,
      new MessageRouter([{ command: "crash", handler: crashHandler }]),
      30_000,
      policy({ key: "proof.crash", player: 100, chat: 100, sensitive: 100 }),
    );
    const crashMessage = message({
      id: "rate-crash",
      sender: "crash-sender",
      chat: "crash-chat",
      text: "$crash",
    });
    const crashed = await crashService.receive(crashMessage);
    const recovered = await crashService.receive(crashMessage);
    if (
      crashed.ok ||
      crashed.error.code !== "ACTION_INVALID" ||
      !recovered.ok ||
      recovered.value.status !== "PROCESSED" ||
      crashCalls !== 2
    ) {
      throw new Error("Crash after admission did not recover safely");
    }
    const crashRateState = await pool.query<{
      charges: string;
      player_used: number;
      chat_used: number;
    }>(
      `SELECT
         (SELECT count(*)::text FROM messaging_rate_limit_charges WHERE inbox_message_id = $1) AS charges,
         (SELECT used FROM messaging_rate_limit_buckets WHERE scope_kind = 'PLAYER' AND policy_key = 'proof.crash.player') AS player_used,
         (SELECT used FROM messaging_rate_limit_buckets WHERE scope_kind = 'CHAT' AND policy_key = 'proof.crash.chat') AS chat_used`,
      [recovered.value.inboxMessageId],
    );
    if (
      crashRateState.rows[0]?.charges !== "2" ||
      crashRateState.rows[0]?.player_used !== 1 ||
      crashRateState.rows[0]?.chat_used !== 1
    ) {
      throw new Error(
        `Rate-limit crash replay double-charged: ${JSON.stringify(crashRateState.rows[0])}`,
      );
    }

    const blockedHandler: MessageRouteHandler = {
      async handle() {
        return err(
          appError("FLOW_BLOCKED", "internal detail must never be sent", {
            internalState: "secret-state",
          }),
        );
      },
    };
    const errorService = new MessagingService(
      repository,
      new MessageRouter([{ command: "blocked", handler: blockedHandler }]),
      30_000,
      policy({ key: "proof.error", player: 100, chat: 100, sensitive: 100 }),
    );
    const blocked = await errorService.receive(
      message({
        id: "friendly-error",
        sender: "error-sender",
        chat: "error-chat",
        text: "$blocked",
      }),
    );
    if (!blocked.ok || blocked.value.resultRefType !== "MESSAGING_ERROR") {
      throw new Error(
        `Typed domain error was not completed as a friendly reply: ${JSON.stringify(blocked)}`,
      );
    }
    const errorOutbox = await pool.query<{ text: string; correlation_id: string }>(
      `SELECT payload->>'text' AS text, correlation_id::text
       FROM outbox_messages
       WHERE causation_id = $1`,
      [blocked.value.inboxMessageId],
    );
    const friendly = errorOutbox.rows[0];
    if (
      friendly === undefined ||
      !friendly.text.includes(`Código de suporte: ${blocked.value.correlationId}`) ||
      friendly.text.includes("internal detail") ||
      friendly.text.includes("secret-state") ||
      friendly.correlation_id !== blocked.value.correlationId
    ) {
      throw new Error(
        `Friendly error leaked internals or lost correlation: ${JSON.stringify(friendly)}`,
      );
    }

    const economy = new EconomyService(new PostgresEconomyRepository(pool));
    const mediaHandler: MessageRouteHandler = {
      async handle(context) {
        const credited = await economy.creditWallet({
          playerId: playerId(registeredPlayerId),
          currencyId,
          amount: 7n,
          idempotencyKey: context.idempotencyKey,
          metadata: {
            sourceType: "WHATSAPP_MESSAGE",
            sourceId: context.inboxMessageId,
            reason: "Phase 13 optional media non-blocking proof",
            actorType: "PLAYER",
            actorId: registeredPlayerId,
            correlationId: context.correlationId,
          },
        });
        if (!credited.ok) return credited;
        return ok({
          resultRefType: "WALLET_LEDGER",
          resultRefId: credited.value.ledgerId,
          outgoing: [],
          mediaProcessing: [{ providerMediaId: "media-proof-1", processorKey: "phase13-proof" }],
        });
      },
    };
    const mediaService = new MessagingService(
      repository,
      new MessageRouter([{ command: "media", handler: mediaHandler }]),
      30_000,
      policy({ key: "proof.media", player: 100, chat: 100, sensitive: 100 }),
    );
    const mediaMessage = message({
      id: "media-message",
      sender: "registered-player",
      chat: "media-chat",
      text: "$media",
      mediaRefs: [
        {
          providerMediaId: "media-proof-1",
          kind: "IMAGE",
          mimeType: "image/png",
          fileName: "proof.png",
        },
      ],
    });
    const mediaReceived = await mediaService.receive(mediaMessage);
    if (!mediaReceived.ok || mediaReceived.value.status !== "PROCESSED") {
      throw new Error(
        `Media-bearing message did not finish mechanics: ${JSON.stringify(mediaReceived)}`,
      );
    }

    const processor = new ProofMediaProcessor();
    const mediaBeforeWorker = await pool.query<{
      amount: string;
      ledger_count: string;
      status: string;
      attempts: number;
      job_count: string;
    }>(
      `SELECT
         (SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2) AS amount,
         (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledger_count,
         (SELECT status FROM messaging_media_jobs WHERE inbox_message_id = $3) AS status,
         (SELECT attempts FROM messaging_media_jobs WHERE inbox_message_id = $3) AS attempts,
         (SELECT count(*)::text FROM messaging_media_jobs WHERE inbox_message_id = $3) AS job_count`,
      [registeredPlayerId, currencyId, mediaReceived.value.inboxMessageId],
    );
    const mediaState = mediaBeforeWorker.rows[0];
    if (
      mediaState?.amount !== "7" ||
      mediaState.ledger_count !== "1" ||
      mediaState.status !== "PENDING" ||
      mediaState.attempts !== 0 ||
      mediaState.job_count !== "1" ||
      processor.processed.length !== 0
    ) {
      throw new Error(
        `Media work blocked or altered mechanical commit: ${JSON.stringify(mediaState)}`,
      );
    }

    const mediaWorker = new MediaWorker(repository, [processor], {
      batchSize: 1,
      staleAfterMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    processor.failNext();
    const mediaFailed = await mediaWorker.runOnce();
    if (mediaFailed.failed !== 1 || processor.processed.length !== 0) {
      throw new Error(`Optional media failure was not isolated: ${JSON.stringify(mediaFailed)}`);
    }
    const mediaRecovered = await mediaWorker.runOnce();
    if (mediaRecovered.processed !== 1 || processor.processed.length !== 1) {
      throw new Error(`Optional media retry did not recover: ${JSON.stringify(mediaRecovered)}`);
    }
    const mediaReplay = await mediaService.receive(mediaMessage);
    if (!mediaReplay.ok || mediaReplay.value.status !== "REPLAYED") {
      throw new Error("Media-bearing Inbox did not replay after asynchronous processing");
    }
    const mediaAfter = await pool.query<{
      amount: string;
      ledger_count: string;
      job_count: string;
      status: string;
      attempts: number;
    }>(
      `SELECT
         (SELECT amount::text FROM wallet_balances WHERE player_id = $1 AND currency_id = $2) AS amount,
         (SELECT count(*)::text FROM wallet_ledger WHERE player_id = $1 AND currency_id = $2) AS ledger_count,
         (SELECT count(*)::text FROM messaging_media_jobs WHERE inbox_message_id = $3) AS job_count,
         (SELECT status FROM messaging_media_jobs WHERE inbox_message_id = $3) AS status,
         (SELECT attempts FROM messaging_media_jobs WHERE inbox_message_id = $3) AS attempts`,
      [registeredPlayerId, currencyId, mediaReceived.value.inboxMessageId],
    );
    const mediaAfterRow = mediaAfter.rows[0];
    if (
      mediaAfterRow?.amount !== "7" ||
      mediaAfterRow.ledger_count !== "1" ||
      mediaAfterRow.job_count !== "1" ||
      mediaAfterRow.status !== "PROCESSED" ||
      mediaAfterRow.attempts !== 2
    ) {
      throw new Error(`Media retry/replay repeated mechanics: ${JSON.stringify(mediaAfterRow)}`);
    }

    console.log(
      "Phase 13 messaging hardening E2E complete: player/chat/action rate limits, safe errors and async media are recovery-safe",
    );
  } finally {
    await pool.end();
  }
}

await main();