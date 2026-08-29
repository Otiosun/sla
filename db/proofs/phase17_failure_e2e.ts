import { Pool } from "pg";
import { FakeWhatsAppAdapter } from "../../src/adapters/whatsapp/fake-whatsapp-adapter.js";
import { BattleOperationalReadService } from "../../src/modules/battle/operational-read-service.js";
import { EncounterOperationalReadService } from "../../src/modules/encounter/operational-read-service.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
} from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import type { MessageRouterPort } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService, OutboxWorker } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresOperationalUxReadModel } from "../../src/platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 17 failure E2E");
}

const PROVIDER = "phase17-failure";
const SENDER = "player:phase17-failure";
const CHAT = "chat:phase17-failure";

function message(
  id: string,
  text: string,
  occurredAt = "2026-08-29T19:00:00-03:00",
): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: PROVIDER,
    externalMessageId: id,
    senderRef: SENDER,
    chatRef: CHAT,
    occurredAt,
    text,
    mediaRefs: [],
    replyToExternalMessageId: null,
  });
}

async function outgoingText(pool: Pool, externalMessageId: string): Promise<string> {
  const result = await pool.query<{ text: string | null }>(
    `SELECT outbox.payload->>'text' AS text
     FROM inbox_messages inbox
     JOIN outbox_messages outbox ON outbox.causation_id = inbox.id
     WHERE inbox.provider = $1
       AND inbox.external_message_id = $2
     ORDER BY outbox.created_at, outbox.id
     LIMIT 1`,
    [PROVIDER, externalMessageId],
  );
  const text = result.rows[0]?.text;
  if (text === null || text === undefined) {
    throw new Error(`Missing outgoing text for ${externalMessageId}`);
  }
  return text;
}

async function receiveProcessed(service: MessagingService, input: IncomingMessage): Promise<void> {
  const result = await service.receive(input);
  if (!result.ok || result.value.status !== "PROCESSED") {
    throw new Error(
      `Message ${input.externalMessageId} did not process: ${JSON.stringify(result)}`,
    );
  }
}

async function locationState(
  pool: Pool,
  playerId: string,
): Promise<{
  readonly areaId: string;
  readonly revision: string;
  readonly receipts: string;
}> {
  const result = await pool.query<{
    area_id: string;
    revision: string;
    receipts: string;
  }>(
    `SELECT location.area_id,
            location.revision::text,
            (SELECT count(*)::text
             FROM world_travel_receipts receipt
             WHERE receipt.player_id = location.player_id) AS receipts
     FROM player_locations location
     WHERE location.player_id = $1`,
    [playerId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Missing player location in Phase 17 failure proof");
  return { areaId: row.area_id, revision: row.revision, receipts: row.receipts };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const playerRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(playerRepository);
    const starter = new PlayerStarterService(
      playerRepository,
      new ManualClock(new Date("2026-08-29T22:00:00Z")),
      new DeterministicRandomSource(17),
    );
    const world = new WorldService(new PostgresWorldRepository(pool), {
      enabled: true,
      reason: null,
    });
    const encounter = new EncounterOperationalReadService(new PostgresEncounterRepository(pool));
    const battle = new BattleOperationalReadService(new PostgresBattleRepository(pool));
    const reads = new PostgresOperationalUxReadModel(pool);

    const createRouter = (): MessageRouter =>
      new MessageRouter(
        createOperationalUxRoutes({ registration, starter, world, encounter, battle, reads }),
      );

    const messagingRepository = new PostgresMessagingRepository(pool);
    const service = new MessagingService(messagingRepository, createRouter(), 30_000);

    const menu = await service.receive(message("f17-menu", "$menu"));
    if (!menu.ok || menu.value.status !== "PROCESSED" || menu.value.resultRefId === null) {
      throw new Error(`Could not bootstrap proof player: ${JSON.stringify(menu)}`);
    }
    const playerId = menu.value.resultRefId;

    await receiveProcessed(service, message("f17-register", "$registrar FailureProof"));
    await receiveProcessed(service, message("f17-regions", "$regioes"));
    await receiveProcessed(service, message("f17-region", "$regiao 1"));
    await receiveProcessed(service, message("f17-starters", "$starters"));
    await receiveProcessed(service, message("f17-starter", "$starter 1"));
    await receiveProcessed(service, message("f17-where", "$onde"));

    const whereText = await outgoingText(pool, "f17-where");
    const travelMatch = whereText.match(/\$ir\s+([a-z0-9-]+)\s+v(\d+)/i);
    if (travelMatch === null) {
      throw new Error(`$onde did not emit a revision-bound travel action: ${whereText}`);
    }
    const destinationSlug = travelMatch[1];
    const emittedRevision = travelMatch[2];
    if (destinationSlug === undefined || emittedRevision === undefined) {
      throw new Error(`Could not parse revision-bound travel action: ${whereText}`);
    }

    // Remove setup replies from the delivery queue so the send-failure assertion targets
    // only the recovered travel reply below.
    const setupAdapter = new FakeWhatsAppAdapter();
    const setupWorker = new OutboxWorker(messagingRepository, [setupAdapter], {
      batchSize: 100,
      staleAfterMs: 1_000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    const setupDrain = await setupWorker.runOnce();
    if (setupDrain.failed !== 0) {
      throw new Error(`Could not drain setup Outbox: ${JSON.stringify(setupDrain)}`);
    }

    // RESTART: inject a failure after the World owner committed but before MessagingService
    // could finish the Inbox/Outbox transaction. A reconstructed service must converge by
    // replaying the domain idempotency receipt rather than moving twice.
    let crashInjected = false;
    const canonicalRouter = createRouter();
    const crashAfterOwnerRouter: MessageRouterPort = {
      classify(input) {
        return canonicalRouter.classify(input);
      },
      async dispatch(context) {
        const routed = await canonicalRouter.dispatch(context);
        if (!crashInjected && context.message.externalMessageId === "f17-travel" && routed.ok) {
          crashInjected = true;
          throw new Error("simulated process crash after committed world travel");
        }
        return routed;
      },
    };
    const crashingService = new MessagingService(
      new PostgresMessagingRepository(pool),
      crashAfterOwnerRouter,
      30_000,
    );
    const travelMessage = message(
      "f17-travel",
      `$ir ${destinationSlug} v${emittedRevision}`,
      "2026-08-29T19:03:00-03:00",
    );
    const crashed = await crashingService.receive(travelMessage);
    if (crashed.ok || crashed.error.code !== "ACTION_INVALID") {
      throw new Error(`Restart crash window was not exercised: ${JSON.stringify(crashed)}`);
    }

    const committedState = await locationState(pool, playerId);
    if (
      committedState.revision !== (BigInt(emittedRevision) + 1n).toString() ||
      committedState.receipts !== "1"
    ) {
      throw new Error(
        `Travel owner commit is not atomic/idempotent: ${JSON.stringify(committedState)}`,
      );
    }

    const restartedService = new MessagingService(
      new PostgresMessagingRepository(pool),
      createRouter(),
      30_000,
    );
    const recovered = await restartedService.receive(travelMessage);
    if (!recovered.ok || recovered.value.status !== "PROCESSED") {
      throw new Error(`Restart did not converge after owner commit: ${JSON.stringify(recovered)}`);
    }

    // DUPLICATE MESSAGE: exact provider/message replay must not dispatch mechanics again.
    const duplicate = await restartedService.receive(travelMessage);
    if (!duplicate.ok || duplicate.value.status !== "REPLAYED") {
      throw new Error(`Duplicate message did not replay safely: ${JSON.stringify(duplicate)}`);
    }
    const afterDuplicate = await locationState(pool, playerId);
    if (
      afterDuplicate.areaId !== committedState.areaId ||
      afterDuplicate.revision !== committedState.revision ||
      afterDuplicate.receipts !== "1"
    ) {
      throw new Error(`Duplicate message repeated mechanics: ${JSON.stringify(afterDuplicate)}`);
    }

    const travelOutbox = await pool.query<{ count: string; status: string; attempts: number }>(
      `SELECT count(*)::text AS count,
              min(outbox.status) AS status,
              min(outbox.attempts)::integer AS attempts
       FROM outbox_messages outbox
       JOIN inbox_messages inbox ON inbox.id = outbox.causation_id
       WHERE inbox.provider = $1
         AND inbox.external_message_id = 'f17-travel'`,
      [PROVIDER],
    );
    const travelOutboxBeforeFailure = travelOutbox.rows[0];
    if (
      travelOutboxBeforeFailure?.count !== "1" ||
      travelOutboxBeforeFailure.status !== "PENDING" ||
      travelOutboxBeforeFailure.attempts !== 0
    ) {
      throw new Error(
        `Recovered/duplicate travel did not create exactly one pending reply: ${JSON.stringify(travelOutboxBeforeFailure)}`,
      );
    }

    // SEND FAILURE: provider delivery failure may change only Outbox delivery state. It must
    // never re-run the already committed world mutation. Reconstructing the worker simulates
    // a process restart before retry.
    const failingAdapter = new FakeWhatsAppAdapter();
    failingAdapter.failNext();
    const failingWorker = new OutboxWorker(
      new PostgresMessagingRepository(pool),
      [failingAdapter],
      {
        batchSize: 1,
        staleAfterMs: 1_000,
        maxAttempts: 3,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      },
    );
    const failedSend = await failingWorker.runOnce();
    if (failedSend.failed !== 1 || failingAdapter.sent.length !== 0) {
      throw new Error(`Injected send failure was not isolated: ${JSON.stringify(failedSend)}`);
    }
    const afterSendFailure = await locationState(pool, playerId);
    if (
      afterSendFailure.areaId !== committedState.areaId ||
      afterSendFailure.revision !== committedState.revision ||
      afterSendFailure.receipts !== "1"
    ) {
      throw new Error(`Send failure repeated mechanics: ${JSON.stringify(afterSendFailure)}`);
    }

    const retryAdapter = new FakeWhatsAppAdapter();
    const restartedWorker = new OutboxWorker(
      new PostgresMessagingRepository(pool),
      [retryAdapter],
      {
        batchSize: 1,
        staleAfterMs: 1_000,
        maxAttempts: 3,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
      },
    );
    const retriedSend = await restartedWorker.runOnce();
    if (retriedSend.sent !== 1 || retriedSend.failed !== 0 || retryAdapter.sent.length !== 1) {
      throw new Error(
        `Outbox restart did not deliver exactly once: ${JSON.stringify(retriedSend)}`,
      );
    }
    const deliveredText = retryAdapter.sent[0]?.payload.text;
    if (typeof deliveredText !== "string" || !deliveredText.includes("Você chegou a")) {
      throw new Error(`Recovered Outbox delivered the wrong reply: ${String(deliveredText)}`);
    }
    const afterDelivery = await locationState(pool, playerId);
    if (
      afterDelivery.areaId !== committedState.areaId ||
      afterDelivery.revision !== committedState.revision ||
      afterDelivery.receipts !== "1"
    ) {
      throw new Error(`Outbox retry changed mechanics: ${JSON.stringify(afterDelivery)}`);
    }

    // STALE ACTION: an old revision-bound action may arrive later, but must become a friendly
    // stale-state reply and must not execute current mechanics.
    const staleMessage = message(
      "f17-stale-action",
      `$ir ${destinationSlug} v${emittedRevision}`,
      "2026-08-29T19:02:00-03:00",
    );
    const stale = await restartedService.receive(staleMessage);
    if (!stale.ok || stale.value.status !== "PROCESSED") {
      throw new Error(`Stale action did not fail safely: ${JSON.stringify(stale)}`);
    }
    const staleText = await outgoingText(pool, staleMessage.externalMessageId);
    if (
      !staleText.includes("Esse estado mudou antes da sua ação") ||
      !staleText.includes("Atualize e tente novamente")
    ) {
      throw new Error(`Stale action did not return the canonical recovery message: ${staleText}`);
    }
    const finalState = await locationState(pool, playerId);
    if (
      finalState.areaId !== committedState.areaId ||
      finalState.revision !== committedState.revision ||
      finalState.receipts !== "1"
    ) {
      throw new Error(`Stale action executed mechanics: ${JSON.stringify(finalState)}`);
    }

    const evidence = await pool.query<{
      travel_inbox_count: string;
      travel_outbox_count: string;
      travel_outbox_status: string;
      travel_outbox_attempts: number;
      stale_inbox_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM inbox_messages WHERE provider = $1 AND external_message_id = 'f17-travel') AS travel_inbox_count,
         (SELECT count(*)::text
          FROM outbox_messages outbox
          JOIN inbox_messages inbox ON inbox.id = outbox.causation_id
          WHERE inbox.provider = $1 AND inbox.external_message_id = 'f17-travel') AS travel_outbox_count,
         (SELECT outbox.status
          FROM outbox_messages outbox
          JOIN inbox_messages inbox ON inbox.id = outbox.causation_id
          WHERE inbox.provider = $1 AND inbox.external_message_id = 'f17-travel') AS travel_outbox_status,
         (SELECT outbox.attempts
          FROM outbox_messages outbox
          JOIN inbox_messages inbox ON inbox.id = outbox.causation_id
          WHERE inbox.provider = $1 AND inbox.external_message_id = 'f17-travel') AS travel_outbox_attempts,
         (SELECT count(*)::text FROM inbox_messages WHERE provider = $1 AND external_message_id = 'f17-stale-action') AS stale_inbox_count`,
      [PROVIDER],
    );
    const row = evidence.rows[0];
    if (
      row?.travel_inbox_count !== "1" ||
      row.travel_outbox_count !== "1" ||
      row.travel_outbox_status !== "SENT" ||
      row.travel_outbox_attempts !== 2 ||
      row.stale_inbox_count !== "1"
    ) {
      throw new Error(`Phase 17 failure evidence mismatch: ${JSON.stringify(row)}`);
    }

    console.log(
      JSON.stringify({
        event: "phase17.failure_e2e.complete",
        duplicateMessage: "replayed_without_mutation",
        restart: "converged_after_owner_commit",
        sendFailure: "retried_once_without_mechanical_replay",
        staleAction: "rejected_without_mutation",
      }),
    );
  } finally {
    await pool.end();
  }
}

await main();
