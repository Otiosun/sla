import { Pool } from "pg";
import { BattleService } from "../../src/modules/battle/service.js";
import type { BattleAction, BattleState } from "../../src/modules/battle/contracts.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { AesBattleSeedReader } from "../../src/platform/rng/battle-seed-reader.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import { createCorrelationId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 9 battle E2E proof");
}

const BATTLE_KEY = Buffer.alloc(32, 0xa5);
const CLOCK = new ManualClock(new Date("2026-08-26T04:00:00.000Z"));

function unwrap<T>(label: string, result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function unwrapBattle<T>(
  label: string,
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (result.ok) return result.value;
  throw new Error(`${label} failed [${result.error.code}]: ${result.error.message}`);
}

function playerMove(state: BattleState): BattleAction {
  const playerSide = state.sides.find((side) => side.controllerKind === "PLAYER");
  const opponentSide = state.sides.find((side) => side.sideNo !== playerSide?.sideNo);
  if (playerSide === undefined || opponentSide === undefined) {
    throw new Error("Battle proof requires exactly one player side and one opponent side");
  }
  const actor = state.combatants.find(
    (combatant) => combatant.participantId === playerSide.activeParticipantId,
  );
  const target = state.combatants.find(
    (combatant) => combatant.participantId === opponentSide.activeParticipantId,
  );
  if (actor === undefined || target === undefined) throw new Error("Active battle combatant is missing");
  const move = actor.moves.find(
    (candidate) =>
      candidate.power !== null &&
      candidate.power > 0 &&
      (candidate.ppCurrent === null || candidate.ppCurrent > 0),
  );
  if (move === undefined) throw new Error("Player has no damaging move for the battle proof");
  return {
    type: "USE_MOVE",
    actorParticipantId: actor.participantId,
    moveSlot: move.slotNo,
    targetParticipantId: target.participantId,
  };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 16 });
  try {
    const region = await pool.query<{ id: string }>("SELECT id FROM regions WHERE slug = 'kanto'");
    const regionId = region.rows[0]?.id;
    if (regionId === undefined) throw new Error("Kanto is missing from the active catalog");

    const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
    const registration = new PlayerRegistrationService(onboardingRepository);
    const starter = new PlayerStarterService(
      onboardingRepository,
      CLOCK,
      new DeterministicRandomSource(9009),
    );
    const identity = unwrap(
      "resolve/create player",
      await registration.resolveOrCreatePlayer({
        provider: "phase9-proof",
        externalId: "battle-e2e",
      }),
    );
    unwrap(
      "create profile",
      await registration.createProfile(identity.playerId, {
        trainerName: "Battle E2E",
        locale: "pt-BR",
      }),
    );
    unwrap("select Kanto", await registration.selectRegion(identity.playerId, { regionId }));
    const selection = unwrap(
      "prepare starter",
      await starter.prepareStarterSelection(identity.playerId),
    );
    const starterOption = selection.options[0];
    if (starterOption === undefined) throw new Error("No active starter option exists");
    unwrap(
      "grant starter",
      await starter.grantStarter(
        identity.playerId,
        { formId: starterOption.formId },
        createCorrelationId(),
      ),
    );
    unwrap("complete onboarding", await starter.completeOnboarding(identity.playerId));

    const world = new WorldService(new PostgresWorldRepository(pool), { enabled: true, reason: null });
    const initial = unwrap(
      "initialize world location",
      await world.ensureInitialLocation({ playerId: identity.playerId }),
    );
    const route = initial.connections.find(
      (connection) => connection.destinationSlug === "route-1" && connection.available,
    );
    if (route === undefined) throw new Error("Pallet Town has no available Route 1 connection");
    const traveled = unwrap(
      "travel to Route 1",
      await world.travel({
        playerId: identity.playerId,
        destinationAreaId: route.destinationAreaId,
        expectedRevision: initial.revision,
      }),
    );
    if (traveled.to.areaSlug !== "route-1") throw new Error("World proof did not reach Route 1");

    const seedProvider = new AesEncounterSeedProvider(
      BATTLE_KEY,
      1,
      () => Buffer.alloc(32, 0x4c),
    );
    const encounter = new EncounterService(
      new PostgresEncounterRepository(pool),
      seedProvider,
      CLOCK,
      { enabled: true, reason: null },
    );
    const created = unwrap(
      "create encounter",
      await encounter.createOrReplay({
        playerId: identity.playerId,
        idempotencyKey: "phase9-encounter",
        encounterTableSlug: "grass-day",
      }),
    );
    const presented = unwrap(
      "observe encounter",
      await encounter.observe({
        playerId: identity.playerId,
        encounterId: created.encounterId,
        expectedRevision: created.revision,
      }),
    );
    const engaged = unwrap(
      "engage encounter",
      await encounter.engage({
        playerId: identity.playerId,
        encounterId: created.encounterId,
        expectedRevision: presented.revision,
      }),
    );
    const started = unwrap(
      "start battle",
      await encounter.startBattle({
        playerId: identity.playerId,
        encounterId: created.encounterId,
        expectedRevision: engaged.revision,
      }),
    );

    const repository = new PostgresBattleRepository(pool);
    const seedReader = new AesBattleSeedReader(new Map([[1, BATTLE_KEY]]));
    const battle = new BattleService(repository, seedReader);
    const initialized = unwrapBattle("initialize battle", await battle.initialize(started.battleId));
    if (initialized.replayed) throw new Error("First battle initialization unexpectedly replayed");
    if (initialized.state.version !== 0 || initialized.state.status !== "ACTIVE") {
      throw new Error("Initial battle snapshot is not ACTIVE version 0");
    }

    const firstAction = playerMove(initialized.state);
    const first = unwrapBattle(
      "resolve first turn",
      await battle.resolvePlayerTurn({
        battleId: started.battleId,
        playerId: identity.playerId,
        expectedVersion: initialized.state.version,
        idempotencyKey: "phase9-turn-1",
        action: firstAction,
      }),
    );
    if (first.replayed) throw new Error("First battle turn unexpectedly replayed");

    const replay = unwrapBattle(
      "replay first turn",
      await battle.resolvePlayerTurn({
        battleId: started.battleId,
        playerId: identity.playerId,
        expectedVersion: initialized.state.version,
        idempotencyKey: "phase9-turn-1",
        action: firstAction,
      }),
    );
    if (!replay.replayed || JSON.stringify(replay.state) !== JSON.stringify(first.state)) {
      throw new Error("Battle idempotency replay did not return the persisted resolved snapshot");
    }

    if (first.state.status !== "ACTIVE") {
      throw new Error("Phase 9 proof expects the seeded battle to survive its first turn");
    }
    const concurrentAction = playerMove(first.state);
    const concurrent = await Promise.allSettled([
      battle.resolvePlayerTurn({
        battleId: started.battleId,
        playerId: identity.playerId,
        expectedVersion: first.state.version,
        idempotencyKey: "phase9-cas-a",
        action: concurrentAction,
      }),
      battle.resolvePlayerTurn({
        battleId: started.battleId,
        playerId: identity.playerId,
        expectedVersion: first.state.version,
        idempotencyKey: "phase9-cas-b",
        action: concurrentAction,
      }),
    ]);
    const fulfilled = concurrent.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<BattleService["resolvePlayerTurn"]>>> =>
        result.status === "fulfilled",
    );
    const winners = fulfilled.filter((result) => result.value.ok);
    const conflicts = fulfilled.filter(
      (result) => !result.value.ok && result.value.error.code === "BATTLE_VERSION_CONFLICT",
    );
    if (concurrent.some((result) => result.status === "rejected")) {
      throw new Error("Concurrent battle CAS leaked a rejected database promise");
    }
    if (winners.length !== 1 || conflicts.length !== 1) {
      throw new Error(`Expected one CAS winner and one version conflict; got ${winners.length}/${conflicts.length}`);
    }

    const restarted = new BattleService(new PostgresBattleRepository(pool), seedReader);
    const recovered = unwrapBattle("reload battle after restart", await restarted.currentState(started.battleId));
    const winningState = winners[0]?.value.ok ? winners[0].value.value.state : null;
    if (winningState === null || JSON.stringify(recovered) !== JSON.stringify(winningState)) {
      throw new Error("Restarted BattleService did not recover the persisted winning snapshot");
    }

    const audit = await pool.query<{
      snapshots: string;
      resolved_actions: string;
      rejected_actions: string;
      events: string;
      min_seq: string | null;
      max_seq: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM battle_state_snapshots WHERE battle_id = $1) AS snapshots,
         (SELECT count(*)::text FROM battle_actions WHERE battle_id = $1 AND status = 'RESOLVED') AS resolved_actions,
         (SELECT count(*)::text FROM battle_actions WHERE battle_id = $1 AND status = 'REJECTED') AS rejected_actions,
         (SELECT count(*)::text FROM battle_events WHERE battle_id = $1) AS events,
         (SELECT min(seq)::text FROM battle_events WHERE battle_id = $1) AS min_seq,
         (SELECT max(seq)::text FROM battle_events WHERE battle_id = $1) AS max_seq`,
      [started.battleId],
    );
    const row = audit.rows[0];
    if (row === undefined) throw new Error("Battle audit query returned no row");
    if (Number(row.snapshots) < 3) throw new Error(`Expected at least 3 snapshots, got ${row.snapshots}`);
    if (row.resolved_actions !== "2" || row.rejected_actions !== "1") {
      throw new Error(`Unexpected action lifecycle counts: ${row.resolved_actions}/${row.rejected_actions}`);
    }
    const eventCount = Number(row.events);
    if (eventCount < 1 || row.min_seq !== "1" || Number(row.max_seq) !== eventCount) {
      throw new Error(`Battle event sequence is not contiguous: ${JSON.stringify(row)}`);
    }

    console.log(
      `Phase 9 E2E complete: battle ${started.battleId}, version ${recovered.version}, snapshots ${row.snapshots}, events ${row.events}`,
    );
  } finally {
    await pool.end();
  }
}

await main();
