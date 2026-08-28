import { Pool } from "pg";
import { BattleOperationalReadService } from "../../src/modules/battle/operational-read-service.js";
import { EncounterOperationalReadService } from "../../src/modules/encounter/operational-read-service.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
} from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import type { MessageRouterPort } from "../../src/modules/messaging/ports.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
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
  throw new Error("DATABASE_URL is required for the Phase 13 operational UX proof");
}

function message(
  id: string,
  text: string,
  occurredAt = "2026-08-28T03:00:00-03:00",
): IncomingMessage {
  return IncomingMessageSchema.parse({
    provider: "phase13-operational",
    externalMessageId: id,
    senderRef: "player:phase13-operational",
    chatRef: "chat:phase13-operational",
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
     WHERE inbox.provider = 'phase13-operational'
       AND inbox.external_message_id = $1
     ORDER BY outbox.created_at, outbox.id
     LIMIT 1`,
    [externalMessageId],
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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const playerRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(playerRepository);
    const starter = new PlayerStarterService(
      playerRepository,
      new ManualClock(new Date("2026-08-28T06:00:00Z")),
      new DeterministicRandomSource(13),
    );
    const world = new WorldService(new PostgresWorldRepository(pool), {
      enabled: true,
      reason: null,
    });
    const encounter = new EncounterOperationalReadService(new PostgresEncounterRepository(pool));
    const battle = new BattleOperationalReadService(new PostgresBattleRepository(pool));
    const reads = new PostgresOperationalUxReadModel(pool);
    const routes = createOperationalUxRoutes({
      registration,
      starter,
      world,
      encounter,
      battle,
      reads,
    });
    const canonicalRouter = new MessageRouter(routes);
    const messagingRepository = new PostgresMessagingRepository(pool);
    const service = new MessagingService(messagingRepository, canonicalRouter, 30_000);

    const menu = message("ux-menu-new", "$menu");
    const menuResult = await service.receive(menu);
    if (
      !menuResult.ok ||
      menuResult.value.status !== "PROCESSED" ||
      menuResult.value.resultRefId === null
    ) {
      throw new Error(`Initial onboarding menu failed: ${JSON.stringify(menuResult)}`);
    }
    const playerId = menuResult.value.resultRefId;
    const newMenuText = await outgoingText(pool, menu.externalMessageId);
    if (!newMenuText.includes("Bem-vindo ao RPG Pokémon") || !newMenuText.includes("$registrar")) {
      throw new Error(`NEW onboarding menu is not actionable: ${newMenuText}`);
    }

    await receiveProcessed(service, message("ux-register", "$registrar Red"));
    await receiveProcessed(service, message("ux-regions", "$regioes"));
    const regionsText = await outgoingText(pool, "ux-regions");
    if (!regionsText.includes("REGIÕES") || !regionsText.includes("$regiao <número>")) {
      throw new Error(`Region menu is not actionable: ${regionsText}`);
    }
    await receiveProcessed(service, message("ux-region", "$regiao 1"));
    await receiveProcessed(service, message("ux-starters", "$starters"));
    const startersText = await outgoingText(pool, "ux-starters");
    if (!startersText.includes("POKÉMON INICIAIS") || !startersText.includes("$starter <número>")) {
      throw new Error(`Starter menu is not actionable: ${startersText}`);
    }
    await receiveProcessed(service, message("ux-starter", "$starter 1"));

    const onboarding = await pool.query<{ state: string }>(
      "SELECT state FROM onboarding_states WHERE player_id = $1",
      [playerId],
    );
    if (onboarding.rows[0]?.state !== "COMPLETE") {
      throw new Error(
        `WhatsApp onboarding did not reach COMPLETE: ${JSON.stringify(onboarding.rows[0])}`,
      );
    }

    await receiveProcessed(service, message("ux-menu-complete", "$menu"));
    const completeMenuText = await outgoingText(pool, "ux-menu-complete");
    if (
      !completeMenuText.includes("CENTRAL DO TREINADOR") ||
      !completeMenuText.includes("$perfil") ||
      !completeMenuText.includes("$onde") ||
      completeMenuText.includes("$explorar") ||
      completeMenuText.includes("$golpe")
    ) {
      throw new Error(`COMPLETE menu violates canonical UX: ${completeMenuText}`);
    }

    for (const [id, command, expected] of [
      ["ux-profile", "$perfil", "PERFIL"],
      ["ux-team", "$equipe", "EQUIPE"],
      ["ux-inventory", "$inventario", "INVENTÁRIO"],
      ["ux-pokedex", "$pokedex", "POKÉDEX"],
    ] as const) {
      await receiveProcessed(service, message(id, command));
      const text = await outgoingText(pool, id);
      if (!text.includes(expected)) throw new Error(`${command} is not mobile-readable: ${text}`);
    }

    await receiveProcessed(service, message("ux-where", "$onde"));
    const whereText = await outgoingText(pool, "ux-where");
    const travelMatch = whereText.match(/\$ir\s+([a-z0-9-]+)\s+v(\d+)/i);
    if (travelMatch === null)
      throw new Error(`$onde did not emit a revision-bound route: ${whereText}`);
    const destinationSlug = travelMatch[1];
    const emittedRevision = travelMatch[2];
    if (destinationSlug === undefined || emittedRevision === undefined) {
      throw new Error(`Could not parse revision-bound travel command: ${whereText}`);
    }

    let crashInjected = false;
    const crashAfterOwnerRouter: MessageRouterPort = {
      classify(input) {
        return canonicalRouter.classify(input);
      },
      async dispatch(context) {
        const routed = await canonicalRouter.dispatch(context);
        if (
          !crashInjected &&
          context.message.externalMessageId === "ux-travel-crash" &&
          routed.ok
        ) {
          crashInjected = true;
          throw new Error("simulated process crash after WorldService.travel commit");
        }
        return routed;
      },
    };
    const crashService = new MessagingService(
      new PostgresMessagingRepository(pool),
      crashAfterOwnerRouter,
      30_000,
    );
    const travelMessage = message(
      "ux-travel-crash",
      `$ir ${destinationSlug} v${emittedRevision}`,
      "2026-08-28T03:03:00-03:00",
    );
    const crashed = await crashService.receive(travelMessage);
    if (crashed.ok || crashed.error.code !== "ACTION_INVALID") {
      throw new Error(`Crash window was not exercised: ${JSON.stringify(crashed)}`);
    }

    const afterCrash = await pool.query<{ area_id: string; revision: string }>(
      "SELECT area_id, revision::text FROM player_locations WHERE player_id = $1",
      [playerId],
    );
    const movedState = afterCrash.rows[0];
    if (
      movedState === undefined ||
      movedState.revision !== (BigInt(emittedRevision) + 1n).toString()
    ) {
      throw new Error(`Owner did not commit before simulated crash: ${JSON.stringify(movedState)}`);
    }
    const receiptAfterCrash = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM world_travel_receipts WHERE player_id = $1",
      [playerId],
    );
    if (receiptAfterCrash.rows[0]?.count !== "1") {
      throw new Error("Travel receipt was not committed atomically with the move");
    }

    const restartedService = new MessagingService(
      new PostgresMessagingRepository(pool),
      new MessageRouter(
        createOperationalUxRoutes({ registration, starter, world, encounter, battle, reads }),
      ),
      30_000,
    );
    const recovered = await restartedService.receive(travelMessage);
    if (!recovered.ok || recovered.value.status !== "PROCESSED") {
      throw new Error(
        `Restart did not replay committed travel safely: ${JSON.stringify(recovered)}`,
      );
    }
    const recoveredText = await outgoingText(pool, travelMessage.externalMessageId);
    if (!recoveredText.includes("Você chegou a")) {
      throw new Error(`Recovered travel did not produce the canonical reply: ${recoveredText}`);
    }

    const duplicate = await restartedService.receive(travelMessage);
    if (!duplicate.ok || duplicate.value.status !== "REPLAYED") {
      throw new Error(
        `Duplicate travel message did not replay Inbox result: ${JSON.stringify(duplicate)}`,
      );
    }
    const afterReplay = await pool.query<{ area_id: string; revision: string; receipts: string }>(
      `SELECT location.area_id, location.revision::text,
              (SELECT count(*)::text FROM world_travel_receipts receipt WHERE receipt.player_id = location.player_id) AS receipts
       FROM player_locations location
       WHERE location.player_id = $1`,
      [playerId],
    );
    if (
      afterReplay.rows[0]?.area_id !== movedState.area_id ||
      afterReplay.rows[0]?.revision !== movedState.revision ||
      afterReplay.rows[0]?.receipts !== "1"
    ) {
      throw new Error(`Retry/duplicate repeated travel: ${JSON.stringify(afterReplay.rows[0])}`);
    }

    const staleOldText = message(
      "ux-travel-stale-reordered",
      `$ir ${destinationSlug} v${emittedRevision}`,
      "2026-08-28T03:02:00-03:00",
    );
    const stale = await restartedService.receive(staleOldText);
    if (!stale.ok || stale.value.status !== "PROCESSED") {
      throw new Error(
        `Stale action was not converted to a safe friendly result: ${JSON.stringify(stale)}`,
      );
    }
    const staleReply = await outgoingText(pool, staleOldText.externalMessageId);
    if (
      !staleReply.includes("Esse estado mudou antes da sua ação") ||
      !staleReply.includes("Atualize e tente novamente")
    ) {
      throw new Error(`Stale action did not explain recovery: ${staleReply}`);
    }
    const finalState = await pool.query<{ area_id: string; revision: string; receipts: string }>(
      `SELECT location.area_id, location.revision::text,
              (SELECT count(*)::text FROM world_travel_receipts receipt WHERE receipt.player_id = location.player_id) AS receipts
       FROM player_locations location
       WHERE location.player_id = $1`,
      [playerId],
    );
    if (
      finalState.rows[0]?.area_id !== movedState.area_id ||
      finalState.rows[0]?.revision !== movedState.revision ||
      finalState.rows[0]?.receipts !== "1"
    ) {
      throw new Error(
        `Stale/reordered text executed mechanics: ${JSON.stringify(finalState.rows[0])}`,
      );
    }

    const readOnlyIdentityCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM player_identities
       WHERE provider = 'phase13-operational'`,
    );
    if (readOnlyIdentityCount.rows[0]?.count !== "1") {
      throw new Error("Read UX unexpectedly created additional players/identities");
    }

    console.log(
      "Phase 13 operational UX E2E complete: onboarding/mobile/world UX and stale/retry/restart travel are safe",
    );
  } finally {
    await pool.end();
  }
}

await main();
