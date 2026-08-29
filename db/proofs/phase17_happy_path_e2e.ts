import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CDomainAdminOperations } from "../../src/modules/admin/domain-definitions.js";
import { AdminDomainOperationService } from "../../src/modules/admin/domain-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { AdminService } from "../../src/modules/admin/service.js";
import type { BattleAction, BattleState } from "../../src/modules/battle/contracts.js";
import { BattleOperationalReadService } from "../../src/modules/battle/operational-read-service.js";
import { BattleService } from "../../src/modules/battle/service.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import { EncounterOperationalReadService } from "../../src/modules/encounter/operational-read-service.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import {
  IncomingMessageSchema,
  type IncomingMessage,
} from "../../src/modules/messaging/contracts.js";
import { createOperationalUxRoutes } from "../../src/modules/messaging/operational-ux-handlers.js";
import { MessageRouter } from "../../src/modules/messaging/router.js";
import { MessagingService } from "../../src/modules/messaging/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { EconomyService } from "../../src/modules/economy/service.js";
import { ProgressionService } from "../../src/modules/progression/service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresCaptureRepository } from "../../src/platform/capture/postgres-capture-repository.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresEconomyRepository } from "../../src/platform/economy/postgres-economy-repository.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresOperationalUxReadModel } from "../../src/platform/messaging/postgres-operational-ux-read-model.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";
import { AesBattleSeedReader } from "../../src/platform/rng/battle-seed-reader.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { createCorrelationId, parsePlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 17 happy-path E2E");
}

const PROVIDER = "phase17-happy";
const SENDER = "player:phase17-happy";
const CHAT = "chat:phase17-happy";
const BATTLE_KEY = Buffer.alloc(32, 0xa5);
const CAPTURE_KEY = Buffer.alloc(32, 0xc7);
const CLOCK = new ManualClock(new Date("2026-08-29T23:40:00Z"));

function unwrap<T>(label: string, result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function unwrapBattle<T>(
  label: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function message(id: string, text: string, offsetMinutes = 0): IncomingMessage {
  const occurredAt = new Date(CLOCK.now().getTime() + offsetMinutes * 60_000).toISOString();
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

async function receiveProcessed(
  service: MessagingService,
  id: string,
  text: string,
  offsetMinutes = 0,
): Promise<void> {
  const result = await service.receive(message(id, text, offsetMinutes));
  if (!result.ok || result.value.status !== "PROCESSED") {
    throw new Error(`${id} did not process: ${JSON.stringify(result)}`);
  }
}

async function outgoingText(pool: Pool, externalMessageId: string): Promise<string> {
  const result = await pool.query<{ text: string | null }>(
    `SELECT outbox.payload->>'text' AS text
     FROM inbox_messages inbox
     JOIN outbox_messages outbox ON outbox.causation_id = inbox.id
     WHERE inbox.provider = $1 AND inbox.external_message_id = $2
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

function playerAction(state: BattleState): BattleAction {
  const playerSide = state.sides.find((side) => side.controllerKind === "PLAYER");
  const opponentSide = state.sides.find((side) => side.sideNo !== playerSide?.sideNo);
  if (playerSide === undefined || opponentSide === undefined) {
    throw new Error("Happy-path battle requires one player side and one opponent side");
  }
  const actor = state.combatants.find(
    (entry) => entry.participantId === playerSide.activeParticipantId,
  );
  if (actor === undefined) throw new Error("Happy-path active player combatant is missing");

  if (actor.currentHp <= 0) {
    const reserve = state.combatants.find(
      (entry) =>
        entry.sideNo === playerSide.sideNo &&
        entry.participantId !== actor.participantId &&
        entry.currentHp > 0,
    );
    if (reserve === undefined) throw new Error("Happy-path player has no living reserve to switch");
    return {
      type: "SWITCH",
      actorParticipantId: actor.participantId,
      switchToParticipantId: reserve.participantId,
    };
  }

  const target = state.combatants.find(
    (entry) => entry.participantId === opponentSide.activeParticipantId,
  );
  if (target === undefined) throw new Error("Happy-path active opponent is missing");
  const move = actor.moves.find(
    (candidate) =>
      candidate.power !== null &&
      candidate.power > 0 &&
      (candidate.ppCurrent === null || candidate.ppCurrent > 0),
  );
  if (move === undefined) throw new Error("Happy-path player has no usable damaging move");
  return {
    type: "USE_MOVE",
    actorParticipantId: actor.participantId,
    moveSlot: move.slotNo,
    targetParticipantId: target.participantId,
  };
}

async function startEncounterBattle(
  encounter: EncounterService,
  battle: BattleService,
  playerId: PlayerId,
  idempotencyKey: string,
): Promise<{
  readonly encounterId: string;
  readonly encounterRevision: bigint;
  readonly battleId: string;
  readonly state: BattleState;
}> {
  const created = unwrap(
    `create ${idempotencyKey}`,
    await encounter.createOrReplay({
      playerId,
      idempotencyKey,
      encounterTableSlug: "grass-day",
    }),
  );
  const observed = unwrap(
    `observe ${idempotencyKey}`,
    await encounter.observe({
      playerId,
      encounterId: created.encounterId,
      expectedRevision: created.revision,
    }),
  );
  const engaged = unwrap(
    `engage ${idempotencyKey}`,
    await encounter.engage({
      playerId,
      encounterId: created.encounterId,
      expectedRevision: observed.revision,
    }),
  );
  const started = unwrap(
    `start battle ${idempotencyKey}`,
    await encounter.startBattle({
      playerId,
      encounterId: created.encounterId,
      expectedRevision: engaged.revision,
    }),
  );
  const initialized = unwrapBattle(
    `initialize battle ${idempotencyKey}`,
    await battle.initialize(started.battleId),
  );
  return {
    encounterId: created.encounterId,
    encounterRevision: started.encounter.revision,
    battleId: started.battleId,
    state: initialized.state,
  };
}

async function winBattle(
  battle: BattleService,
  battleId: string,
  playerId: PlayerId,
  initial: BattleState,
): Promise<BattleState> {
  let state = initial;
  for (let turn = 1; turn <= 64 && state.status === "ACTIVE"; turn += 1) {
    const resolved = unwrapBattle(
      `resolve winning turn ${turn}`,
      await battle.resolvePlayerTurn({
        battleId,
        playerId,
        expectedVersion: state.version,
        idempotencyKey: `phase17-happy-win-${turn}`,
        action: playerAction(state),
      }),
    );
    state = resolved.state;
  }
  if (state.status !== "WON") {
    throw new Error(`Happy-path battle did not end WON: ${state.status} v${state.version}`);
  }
  return state;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  try {
    const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(onboardingRepository);
    const starter = new PlayerStarterService(
      onboardingRepository,
      CLOCK,
      new DeterministicRandomSource(17_008),
    );
    const world = new WorldService(new PostgresWorldRepository(pool), {
      enabled: true,
      reason: null,
    });
    const encounterRepository = new PostgresEncounterRepository(pool);
    const battleRepository = new PostgresBattleRepository(pool);
    const reads = new PostgresOperationalUxReadModel(pool);
    const messaging = new MessagingService(
      new PostgresMessagingRepository(pool),
      new MessageRouter(
        createOperationalUxRoutes({
          registration,
          starter,
          world,
          encounter: new EncounterOperationalReadService(encounterRepository),
          battle: new BattleOperationalReadService(battleRepository),
          reads,
        }),
      ),
      30_000,
    );

    // cadastro → starter
    const menu = await messaging.receive(message("f17-happy-menu", "$menu"));
    if (!menu.ok || menu.value.status !== "PROCESSED" || menu.value.resultRefId === null) {
      throw new Error(`Happy-path initial menu failed: ${JSON.stringify(menu)}`);
    }
    const parsedPlayerId = parsePlayerId(menu.value.resultRefId);
    if (!parsedPlayerId.ok) throw new Error("Happy-path menu returned invalid PlayerId");
    const playerId = parsedPlayerId.value;

    await receiveProcessed(messaging, "f17-happy-register", "$registrar HappyPath", 1);
    await receiveProcessed(messaging, "f17-happy-regions", "$regioes", 2);
    await receiveProcessed(messaging, "f17-happy-region", "$regiao 1", 3);
    await receiveProcessed(messaging, "f17-happy-starters", "$starters", 4);
    await receiveProcessed(messaging, "f17-happy-starter", "$starter 1", 5);

    const onboarding = await pool.query<{ state: string }>(
      "SELECT state FROM onboarding_states WHERE player_id = $1",
      [playerId],
    );
    if (onboarding.rows[0]?.state !== "COMPLETE") {
      throw new Error(
        `Happy-path onboarding did not complete: ${JSON.stringify(onboarding.rows[0])}`,
      );
    }

    // perfil: prove the post-starter user-facing projection, not a second profile mutation.
    await receiveProcessed(messaging, "f17-happy-profile", "$perfil", 6);
    const profileText = await outgoingText(pool, "f17-happy-profile");
    if (!profileText.includes("PERFIL") || !profileText.includes("HappyPath")) {
      throw new Error(`Post-starter profile is not readable: ${profileText}`);
    }
    const team = await reads.listTeam(playerId);
    if (team.length !== 1)
      throw new Error(`Starter team projection expected 1 member, got ${team.length}`);

    // viajar
    await receiveProcessed(messaging, "f17-happy-where", "$onde", 7);
    const whereText = await outgoingText(pool, "f17-happy-where");
    const travelMatch = whereText.match(/\$ir\s+([a-z0-9-]+)\s+v(\d+)/i);
    const destinationSlug = travelMatch?.[1];
    const revision = travelMatch?.[2];
    if (destinationSlug !== "route-1" || revision === undefined) {
      throw new Error(`Happy-path route command was not Route 1: ${whereText}`);
    }
    await receiveProcessed(messaging, "f17-happy-travel", `$ir ${destinationSlug} v${revision}`, 8);
    const location = await pool.query<{ slug: string }>(
      `SELECT area.slug
       FROM player_locations location
       JOIN areas area ON area.id = location.area_id
       WHERE location.player_id = $1`,
      [playerId],
    );
    if (location.rows[0]?.slug !== "route-1")
      throw new Error("Happy-path travel did not reach Route 1");

    // encontro → battle
    const encounter = new EncounterService(
      encounterRepository,
      new AesEncounterSeedProvider(BATTLE_KEY, 1, () => Buffer.alloc(32, 0x4c)),
      CLOCK,
      { enabled: true, reason: null },
    );
    const battle = new BattleService(
      battleRepository,
      new AesBattleSeedReader(new Map([[1, BATTLE_KEY]])),
    );
    const captureBattle = await startEncounterBattle(
      encounter,
      battle,
      playerId,
      "phase17-happy-capture-encounter",
    );
    const firstTurn = unwrapBattle(
      "resolve pre-capture battle turn",
      await battle.resolvePlayerTurn({
        battleId: captureBattle.battleId,
        playerId,
        expectedVersion: captureBattle.state.version,
        idempotencyKey: "phase17-happy-capture-turn",
        action: playerAction(captureBattle.state),
      }),
    );
    if (firstTurn.state.status !== "ACTIVE") {
      throw new Error(`Pre-capture battle ended before item/capture: ${firstTurn.state.status}`);
    }

    // item: provision a real Poké Ball through the Economy owner, then expose it via inventory UX.
    const ball = await pool.query<{ id: string }>("SELECT id FROM items WHERE slug = 'poke-ball'");
    const ballItemId = ball.rows[0]?.id;
    if (ballItemId === undefined) throw new Error("Canonical Poké Ball item is missing");
    const economy = new EconomyService(new PostgresEconomyRepository(pool));
    const itemGrant = unwrap(
      "grant capture item through EconomyService",
      await economy.addItem({
        playerId,
        itemId: ballItemId,
        quantity: 1n,
        idempotencyKey: "phase17-happy-ball-grant",
        metadata: {
          sourceType: "PHASE17_E2E",
          sourceId: captureBattle.encounterId,
          reason: "Phase 17 happy-path capture item",
          actorType: "SYSTEM",
          actorId: null,
          correlationId: randomUUID(),
        },
      }),
    );
    if (itemGrant.quantity !== 1n || itemGrant.replayed) {
      throw new Error(
        `Economy item grant was not first-write quantity 1: ${JSON.stringify(itemGrant)}`,
      );
    }
    const inventory = await reads.listInventory(playerId);
    const ballView = inventory.find((entry) => entry.itemId === ballItemId);
    if (ballView?.quantity !== 1n)
      throw new Error("Poké Ball is not visible in operational inventory");
    await receiveProcessed(messaging, "f17-happy-inventory", "$inventario", 9);
    const inventoryText = await outgoingText(pool, "f17-happy-inventory");
    if (!inventoryText.includes("INVENTÁRIO") || !inventoryText.includes(ballView.displayName)) {
      throw new Error(`Granted item is not visible through inventory UX: ${inventoryText}`);
    }

    // captura → Pokédex
    const capture = new CaptureService(
      new PostgresCaptureRepository(pool),
      new AesEncounterSeedProvider(CAPTURE_KEY, 2, () => Buffer.alloc(32, 0x00)),
    );
    const captured = unwrap(
      "capture wild Pokemon",
      await capture.attempt({
        playerId,
        encounterId: captureBattle.encounterId,
        expectedEncounterRevision: captureBattle.encounterRevision,
        expectedBattleVersion: firstTurn.state.version,
        ballItemId,
        idempotencyKey: "phase17-happy-capture",
        correlationId: createCorrelationId(),
        causationId: null,
      }),
    );
    if (captured.status !== "CAPTURED" || captured.pokemonInstanceId === null) {
      throw new Error(
        `Deterministic happy-path capture did not succeed: ${JSON.stringify(captured)}`,
      );
    }
    const ballAfterCapture = await pool.query<{ quantity: string; consume_ledgers: string }>(
      `SELECT balance.quantity::text AS quantity,
              (SELECT count(*)::text FROM inventory_ledger ledger
               WHERE ledger.player_id = $1 AND ledger.item_id = $2
                 AND ledger.idempotency_scope = 'capture.consume') AS consume_ledgers
       FROM inventory_balances balance
       WHERE balance.player_id = $1 AND balance.item_id = $2`,
      [playerId, ballItemId],
    );
    if (
      ballAfterCapture.rows[0]?.quantity !== "0" ||
      ballAfterCapture.rows[0]?.consume_ledgers !== "1"
    ) {
      throw new Error(
        `Capture did not consume exactly one item: ${JSON.stringify(ballAfterCapture.rows[0])}`,
      );
    }

    const pokedex = await reads.listPokedex(playerId);
    const caughtSpecies = pokedex.find((entry) => entry.caughtCount > 0n);
    if (caughtSpecies === undefined)
      throw new Error("Capture did not establish a caught Pokédex entry");
    await receiveProcessed(messaging, "f17-happy-pokedex", "$pokedex", 10);
    const pokedexText = await outgoingText(pool, "f17-happy-pokedex");
    if (!pokedexText.includes("POKÉDEX") || !pokedexText.includes(caughtSpecies.displayName)) {
      throw new Error(`Caught species is not visible through Pokédex UX: ${pokedexText}`);
    }

    // XP: a capture terminates its battle as CANCELLED by design, so earn XP from a second real WON battle.
    const rewardBattle = await startEncounterBattle(
      encounter,
      battle,
      playerId,
      "phase17-happy-reward-encounter",
    );
    const won = await winBattle(battle, rewardBattle.battleId, playerId, rewardBattle.state);
    if (won.status !== "WON") throw new Error("Reward battle did not finish with a player win");

    const progression = new ProgressionService(new PostgresProgressionRepository(pool));
    const reward = unwrap(
      "apply battle XP reward",
      await progression.applyBattleReward({
        battleId: rewardBattle.battleId,
        idempotencyKey: "phase17-happy-reward",
        correlationId: randomUUID(),
      }),
    );
    if (
      reward.replayed ||
      reward.playerId !== playerId ||
      reward.pokemon.length === 0 ||
      !reward.pokemon.some((entry) => entry.awardedXp > 0) ||
      reward.trainer.pointsGained <= 0
    ) {
      throw new Error(
        `Battle reward did not grant Pokemon/trainer progress: ${JSON.stringify(reward)}`,
      );
    }

    // admin inspect/edit: one scoped ECONOMY_ADMIN may read this player and apply an auditable R2 edit.
    const economyRole = await pool.query<{ id: string }>(
      "SELECT id FROM admin_roles WHERE slug = 'ECONOMY_ADMIN'",
    );
    const roleId = economyRole.rows[0]?.id;
    if (roleId === undefined) throw new Error("ECONOMY_ADMIN role is missing");
    const principalId = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id, identity_ref, status) VALUES ($1, $2, 'ACTIVE')",
      [principalId, `phase17:happy-admin:${principalId}`],
    );
    await pool.query("INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)", [
      principalId,
      roleId,
    ]);
    await pool.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'PLAYER', $3)`,
      [randomUUID(), principalId, playerId],
    );

    const adminRepository = new PostgresAdminRepository(pool);
    const domain = new AdminDomainOperationService(
      economy,
      progression,
      new PostgresAdminOperationCompletion(pool),
    );
    const admin = new AdminService(
      registerPhase12CDomainAdminOperations(
        createPhase12AdminOperationRegistry(adminRepository),
        domain,
      ),
      adminRepository,
    );
    const inspected = await admin.authorizeRead({
      principalId,
      operationType: "player.read",
      input: { playerId },
    });
    if (inspected.id !== playerId)
      throw new Error("Admin inspect did not resolve the target player");

    const prepared = await admin.prepareMutation({
      principalId,
      operationType: "inventory.adjust",
      input: { playerId, itemId: ballItemId, delta: "1" },
      reason: "Phase 17 happy-path audited admin edit",
      idempotencyKey: "phase17-happy-admin-edit",
      correlationId: randomUUID(),
    });
    if (prepared.operation.status !== "READY") {
      throw new Error(`R2 admin edit was not READY: ${prepared.operation.status}`);
    }
    const applied = await admin.apply(prepared.operation.id, principalId);
    if (applied.status !== "APPLIED" || applied.result?.balanceAfter !== "1") {
      throw new Error(`Admin edit did not apply through domain owner: ${JSON.stringify(applied)}`);
    }

    const finalAudit = await pool.query<{
      onboarding_state: string;
      area_slug: string;
      captured: string;
      pokedex_caught: string;
      reward_claims: string;
      xp_ledgers: string;
      admin_changes: string;
      admin_audits: string;
      admin_inventory_ledgers: string;
      ball_quantity: string;
    }>(
      `SELECT
         (SELECT state FROM onboarding_states WHERE player_id = $1) AS onboarding_state,
         (SELECT area.slug FROM player_locations location JOIN areas area ON area.id = location.area_id
           WHERE location.player_id = $1) AS area_slug,
         (SELECT count(*)::text FROM pokemon_instances
           WHERE owner_player_id = $1 AND origin_type = 'CAPTURE') AS captured,
         (SELECT COALESCE(sum(caught_count), 0)::text FROM player_pokedex_species
           WHERE player_id = $1) AS pokedex_caught,
         (SELECT count(*)::text FROM battle_reward_claims
           WHERE player_id = $1 AND battle_id = $2) AS reward_claims,
         (SELECT count(*)::text FROM pokemon_xp_ledger
           WHERE source_type = 'BATTLE_REWARD' AND source_id = $2::text) AS xp_ledgers,
         (SELECT count(*)::text FROM admin_operation_changes
           WHERE admin_operation_id = $3) AS admin_changes,
         (SELECT count(*)::text FROM audit_events WHERE causation_id = $3) AS admin_audits,
         (SELECT count(*)::text FROM inventory_ledger
           WHERE source_type = 'ADMIN_OPERATION' AND source_id = $3::text) AS admin_inventory_ledgers,
         (SELECT quantity::text FROM inventory_balances
           WHERE player_id = $1 AND item_id = $4) AS ball_quantity`,
      [playerId, rewardBattle.battleId, applied.id, ballItemId],
    );
    const audit = finalAudit.rows[0];
    if (
      audit === undefined ||
      audit.onboarding_state !== "COMPLETE" ||
      audit.area_slug !== "route-1" ||
      audit.captured !== "1" ||
      Number(audit.pokedex_caught) < 1 ||
      audit.reward_claims !== "1" ||
      Number(audit.xp_ledgers) < 1 ||
      audit.admin_changes !== "1" ||
      audit.admin_audits !== "1" ||
      audit.admin_inventory_ledgers !== "1" ||
      audit.ball_quantity !== "1"
    ) {
      throw new Error(`Phase 17 happy-path final audit failed: ${JSON.stringify(audit)}`);
    }

    console.log(
      `Phase 17.8 happy-path E2E complete for player ${playerId}: capture=${captured.captureAttemptId}, rewardBattle=${rewardBattle.battleId}, adminOperation=${applied.id}`,
    );
  } finally {
    await pool.end();
  }
}

await main();
