import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { BattleAction, BattleState } from "../../src/modules/battle/contracts.js";
import { BattleService } from "../../src/modules/battle/service.js";
import type { CaptureRepository, CaptureTransaction } from "../../src/modules/capture/ports.js";
import { CaptureService } from "../../src/modules/capture/service.js";
import type { WildPokemonSnapshot } from "../../src/modules/encounter/contracts.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import { PlayerRegistrationService } from "../../src/modules/player/registration-service.js";
import { PlayerStarterService } from "../../src/modules/player/starter-service.js";
import { WorldService } from "../../src/modules/world/service.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresCaptureRepository } from "../../src/platform/capture/postgres-capture-repository.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { PostgresPlayerOnboardingRepository } from "../../src/platform/player/postgres-player-onboarding-repository.js";
import { AesBattleSeedReader } from "../../src/platform/rng/battle-seed-reader.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import { PostgresWorldRepository } from "../../src/platform/world/postgres-world-repository.js";
import {
  createCorrelationId,
  type EncounterId,
  type PlayerId,
} from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 10 capture E2E proof");
}

const BATTLE_KEY = Buffer.alloc(32, 0xa5);
const CAPTURE_KEY = Buffer.alloc(32, 0xc7);
const CLOCK = new ManualClock(new Date("2026-08-26T10:00:00.000Z"));

interface EngagedFixture {
  readonly playerId: PlayerId;
  readonly encounterId: EncounterId;
  readonly revision: bigint;
  readonly snapshot: WildPokemonSnapshot;
  readonly encounter: EncounterService;
}

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

function playerMove(state: BattleState): BattleAction {
  const playerSide = state.sides.find((side) => side.controllerKind === "PLAYER");
  const opponentSide = state.sides.find((side) => side.sideNo !== playerSide?.sideNo);
  if (playerSide === undefined || opponentSide === undefined) {
    throw new Error("Capture proof requires one player side and one opponent side");
  }
  const actor = state.combatants.find(
    (combatant) => combatant.participantId === playerSide.activeParticipantId,
  );
  const target = state.combatants.find(
    (combatant) => combatant.participantId === opponentSide.activeParticipantId,
  );
  if (actor === undefined || target === undefined) {
    throw new Error("Capture proof battle is missing an active combatant");
  }
  const move = actor.moves.find(
    (candidate) =>
      candidate.power !== null &&
      candidate.power > 0 &&
      (candidate.ppCurrent === null || candidate.ppCurrent > 0),
  );
  if (move === undefined) throw new Error("Capture proof player has no damaging move");
  return {
    type: "USE_MOVE",
    actorParticipantId: actor.participantId,
    moveSlot: move.slotNo,
    targetParticipantId: target.participantId,
  };
}

async function prepareEngagedEncounter(
  pool: Pool,
  externalId: string,
  encounterKey: string,
): Promise<EngagedFixture> {
  const region = await pool.query<{ id: string }>("SELECT id FROM regions WHERE slug = 'kanto'");
  const regionId = region.rows[0]?.id;
  if (regionId === undefined) throw new Error("Kanto is missing from the active catalog");

  const onboardingRepository = new PostgresPlayerOnboardingRepository(pool);
  const registration = new PlayerRegistrationService(onboardingRepository);
  const starter = new PlayerStarterService(
    onboardingRepository,
    CLOCK,
    new DeterministicRandomSource(10_010),
  );
  const identity = unwrap(
    "resolve/create capture player",
    await registration.resolveOrCreatePlayer({ provider: "phase10-proof", externalId }),
  );
  unwrap(
    "create capture profile",
    await registration.createProfile(identity.playerId, {
      trainerName: `Capture ${externalId}`,
      locale: "pt-BR",
    }),
  );
  unwrap("select Kanto", await registration.selectRegion(identity.playerId, { regionId }));
  const selection = unwrap(
    "prepare capture starter",
    await starter.prepareStarterSelection(identity.playerId),
  );
  const starterOption = selection.options[0];
  if (starterOption === undefined)
    throw new Error("No active starter option exists for capture proof");
  unwrap(
    "grant capture starter",
    await starter.grantStarter(
      identity.playerId,
      { formId: starterOption.formId },
      createCorrelationId(),
    ),
  );
  unwrap("complete capture onboarding", await starter.completeOnboarding(identity.playerId));

  const world = new WorldService(new PostgresWorldRepository(pool), {
    enabled: true,
    reason: null,
  });
  const initial = unwrap(
    "initialize capture world location",
    await world.ensureInitialLocation({ playerId: identity.playerId }),
  );
  const route = initial.connections.find(
    (connection) => connection.destinationSlug === "route-1" && connection.available,
  );
  if (route === undefined) throw new Error("Pallet Town has no available Route 1 connection");
  unwrap(
    "travel capture player to Route 1",
    await world.travel({
      playerId: identity.playerId,
      destinationAreaId: route.destinationAreaId,
      expectedRevision: initial.revision,
    }),
  );

  const encounter = new EncounterService(
    new PostgresEncounterRepository(pool),
    new AesEncounterSeedProvider(BATTLE_KEY, 1, () => Buffer.alloc(32, 0x4c)),
    CLOCK,
    { enabled: true, reason: null },
  );
  const created = unwrap(
    "create capture encounter",
    await encounter.createOrReplay({
      playerId: identity.playerId,
      idempotencyKey: encounterKey,
      encounterTableSlug: "grass-day",
    }),
  );
  const presented = unwrap(
    "observe capture encounter",
    await encounter.observe({
      playerId: identity.playerId,
      encounterId: created.encounterId,
      expectedRevision: created.revision,
    }),
  );
  const engaged = unwrap(
    "engage capture encounter",
    await encounter.engage({
      playerId: identity.playerId,
      encounterId: created.encounterId,
      expectedRevision: presented.revision,
    }),
  );
  return {
    playerId: identity.playerId,
    encounterId: created.encounterId,
    revision: engaged.revision,
    snapshot: created.snapshot,
    encounter,
  };
}

async function pokeBallId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM items WHERE slug = 'poke-ball'");
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("Poké Ball identity is missing from the catalog");
  return id;
}

async function setBallBalance(
  pool: Pool,
  playerId: PlayerId,
  ballItemId: string,
  quantity: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO inventory_balances(player_id, item_id, quantity, revision)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (player_id, item_id)
     DO UPDATE SET quantity = EXCLUDED.quantity, revision = 0, updated_at = now()`,
    [playerId, ballItemId, quantity],
  );
}

async function fillTeamToSix(pool: Pool, playerId: PlayerId): Promise<void> {
  const template = await pool.query<{
    form_id: string;
    level: number;
    current_hp: number;
    gender: string | null;
    shiny: boolean;
    ability_id: string | null;
  }>(
    `SELECT form_id, level, current_hp, gender, shiny, ability_id
     FROM pokemon_instances
     WHERE owner_player_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at, id
     LIMIT 1`,
    [playerId],
  );
  const source = template.rows[0];
  if (source === undefined) throw new Error("Capture proof player has no Pokemon template");
  const occupied = await pool.query<{ slot_no: number }>(
    `SELECT slot_no FROM pokemon_roster_slots
     WHERE player_id = $1 AND placement_kind = 'TEAM'`,
    [playerId],
  );
  const slots = new Set(occupied.rows.map((row) => row.slot_no));
  for (let slot = 1; slot <= 6; slot += 1) {
    if (slots.has(slot)) continue;
    const pokemonId = randomUUID();
    await pool.query(
      `INSERT INTO pokemon_instances(
         id, owner_player_id, form_id, level, current_hp, gender, shiny, ability_id,
         origin_type, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PHASE10_PROOF', $9::jsonb)`,
      [
        pokemonId,
        playerId,
        source.form_id,
        source.level,
        source.current_hp,
        source.gender,
        source.shiny,
        source.ability_id,
        JSON.stringify({ fixture: true, slot }),
      ],
    );
    await pool.query(
      `INSERT INTO pokemon_roster_slots(
         pokemon_instance_id, player_id, placement_kind, box_no, slot_no
       ) VALUES ($1, $2, 'TEAM', NULL, $3)`,
      [pokemonId, playerId, slot],
    );
  }
}

class CrashAfterBallRepository implements CaptureRepository {
  public constructor(private readonly delegate: CaptureRepository) {}

  public transaction<T>(work: (transaction: CaptureTransaction) => Promise<T>): Promise<T> {
    return this.delegate.transaction((transaction) => {
      const injected: CaptureTransaction = {
        findAttempt: (key) => transaction.findAttempt(key),
        loadContext: (playerId, encounterId, ballItemId) =>
          transaction.loadContext(playerId, encounterId, ballItemId),
        beginResolving: (input) => transaction.beginResolving(input),
        insertPending: (input) => transaction.insertPending(input),
        consumeBall: async (input) => {
          const result = await transaction.consumeBall(input);
          if (result === "CONSUMED") throw new Error("phase10 simulated crash after Ball consume");
          return result;
        },
        nextRosterPlacement: (playerId) => transaction.nextRosterPlacement(playerId),
        resolveFailure: (input) => transaction.resolveFailure(input),
        resolveSuccess: (input) => transaction.resolveSuccess(input),
      };
      return work(injected);
    });
  }
}

async function proveConcurrentBattleSuccess(pool: Pool, ballItemId: string): Promise<void> {
  const fixture = await prepareEngagedEncounter(
    pool,
    "capture-success",
    "phase10-success-encounter",
  );
  const started = unwrap(
    "start capture battle",
    await fixture.encounter.startBattle({
      playerId: fixture.playerId,
      encounterId: fixture.encounterId,
      expectedRevision: fixture.revision,
    }),
  );
  const battleRepository = new PostgresBattleRepository(pool);
  const battle = new BattleService(
    battleRepository,
    new AesBattleSeedReader(new Map([[1, BATTLE_KEY]])),
  );
  const initialized = unwrapBattle(
    "initialize capture battle",
    await battle.initialize(started.battleId),
  );
  const first = unwrapBattle(
    "resolve capture setup turn",
    await battle.resolvePlayerTurn({
      battleId: started.battleId,
      playerId: fixture.playerId,
      expectedVersion: initialized.state.version,
      idempotencyKey: "phase10-setup-turn",
      action: playerMove(initialized.state),
    }),
  );
  if (first.state.status !== "ACTIVE") {
    throw new Error("Seeded capture battle ended before the capture attempt");
  }
  const wild = first.state.combatants.find(
    (combatant) => combatant.participantKind === "WILD_POKEMON",
  );
  if (wild === undefined || wild.currentHp <= 0) {
    throw new Error("Capture proof has no living wild target after setup turn");
  }

  await fillTeamToSix(pool, fixture.playerId);
  await setBallBalance(pool, fixture.playerId, ballItemId, 3);
  const capture = new CaptureService(
    new PostgresCaptureRepository(pool),
    new AesEncounterSeedProvider(CAPTURE_KEY, 2, () => Buffer.alloc(32, 0x00)),
  );
  const input = {
    playerId: fixture.playerId,
    encounterId: fixture.encounterId,
    expectedEncounterRevision: started.encounter.revision,
    expectedBattleVersion: first.state.version,
    ballItemId,
    idempotencyKey: "phase10-concurrent-success",
    correlationId: createCorrelationId(),
    causationId: null,
    explicitModifierBasisPoints: [100_000],
  } as const;
  const concurrent = await Promise.all([capture.attempt(input), capture.attempt(input)]);
  const values = concurrent.map((result, index) => unwrap(`concurrent capture ${index}`, result));
  const primary = values.find((value) => !value.replayed);
  const replay = values.find((value) => value.replayed);
  if (primary === undefined || replay === undefined) {
    throw new Error(
      "Concurrent duplicate capture did not produce one primary result and one replay",
    );
  }
  if (
    primary.status !== "CAPTURED" ||
    replay.status !== "CAPTURED" ||
    primary.captureAttemptId !== replay.captureAttemptId ||
    primary.pokemonInstanceId === null ||
    primary.pokemonInstanceId !== replay.pokemonInstanceId
  ) {
    throw new Error("Concurrent duplicate capture did not converge on one durable capture");
  }
  if (
    primary.placement?.placementKind !== "BOX" ||
    primary.placement.boxNo !== 1 ||
    primary.placement.slotNo !== 1
  ) {
    throw new Error(
      `Full Team did not route captured Pokemon to Box 1 slot 1: ${JSON.stringify(primary.placement)}`,
    );
  }

  const audit = await pool.query<{
    attempts: string;
    ledger_rows: string;
    balance: string;
    pokemon_rows: string;
    outbox_rows: string;
    encounter_status: string;
    battle_status: string;
    battle_version: string;
    cancelled_sides: string;
    capture_events: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM capture_attempts WHERE player_id = $1) AS attempts,
       (SELECT count(*)::text FROM inventory_ledger
         WHERE player_id = $1 AND idempotency_scope = 'capture.consume') AS ledger_rows,
       (SELECT quantity::text FROM inventory_balances WHERE player_id = $1 AND item_id = $2) AS balance,
       (SELECT count(*)::text FROM pokemon_instances WHERE origin_type = 'CAPTURE' AND origin_id = $3) AS pokemon_rows,
       (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key = $4) AS outbox_rows,
       (SELECT status FROM encounters WHERE id = $5) AS encounter_status,
       (SELECT status FROM battles WHERE id = $6) AS battle_status,
       (SELECT version::text FROM battles WHERE id = $6) AS battle_version,
       (SELECT count(*)::text FROM battle_sides WHERE battle_id = $6 AND result = 'CANCELLED') AS cancelled_sides,
       (SELECT count(*)::text FROM battle_events
         WHERE battle_id = $6 AND event_type = 'BattleEnded'
           AND payload ->> 'reason' = 'POKEMON_CAPTURED'
           AND payload ->> 'captureAttemptId' = $3::text) AS capture_events`,
    [
      fixture.playerId,
      ballItemId,
      primary.captureAttemptId,
      `capture.result:${primary.captureAttemptId}`,
      fixture.encounterId,
      started.battleId,
    ],
  );
  const row = audit.rows[0];
  if (row === undefined) throw new Error("Capture success audit returned no row");
  if (
    row.attempts !== "1" ||
    row.ledger_rows !== "1" ||
    row.balance !== "2" ||
    row.pokemon_rows !== "1" ||
    row.outbox_rows !== "1" ||
    row.encounter_status !== "CAPTURED" ||
    row.battle_status !== "CANCELLED" ||
    Number(row.battle_version) !== first.state.version + 1 ||
    row.cancelled_sides !== "2" ||
    row.capture_events !== "1"
  ) {
    throw new Error(`Capture success atomicity audit failed: ${JSON.stringify(row)}`);
  }

  const captured = await pool.query<{
    form_id: string;
    level: number;
    current_hp: number;
    gender: string | null;
    shiny: boolean;
    ability_id: string | null;
    nature_id: string | null;
    iv_hp: number | null;
    iv_attack: number | null;
    iv_defense: number | null;
    iv_sp_attack: number | null;
    iv_sp_defense: number | null;
    iv_speed: number | null;
  }>(
    `SELECT instance.form_id, instance.level, instance.current_hp, instance.gender,
            instance.shiny, instance.ability_id, training.nature_id,
            training.iv_hp, training.iv_attack, training.iv_defense,
            training.iv_sp_attack, training.iv_sp_defense, training.iv_speed
     FROM pokemon_instances instance
     JOIN pokemon_training_values training ON training.pokemon_instance_id = instance.id
     WHERE instance.id = $1`,
    [primary.pokemonInstanceId],
  );
  const capturedRow = captured.rows[0];
  if (capturedRow === undefined) throw new Error("Captured Pokemon instance is missing");
  const snapshot = fixture.snapshot;
  if (
    capturedRow.form_id !== snapshot.formId ||
    capturedRow.level !== snapshot.level ||
    capturedRow.current_hp !== wild.currentHp ||
    capturedRow.gender !== snapshot.gender ||
    capturedRow.shiny !== snapshot.shiny ||
    capturedRow.ability_id !== snapshot.abilityId ||
    capturedRow.nature_id !== snapshot.natureId ||
    capturedRow.iv_hp !== snapshot.ivs.hp ||
    capturedRow.iv_attack !== snapshot.ivs.attack ||
    capturedRow.iv_defense !== snapshot.ivs.defense ||
    capturedRow.iv_sp_attack !== snapshot.ivs.spAttack ||
    capturedRow.iv_sp_defense !== snapshot.ivs.spDefense ||
    capturedRow.iv_speed !== snapshot.ivs.speed
  ) {
    throw new Error(
      `Captured Pokemon did not preserve pinned wild identity/state: ${JSON.stringify(capturedRow)}`,
    );
  }

  const capturedMoves = await pool.query<{ move_id: string; pp_current: number | null }>(
    `SELECT move_id, pp_current FROM pokemon_move_slots
     WHERE pokemon_instance_id = $1 ORDER BY slot_no`,
    [primary.pokemonInstanceId],
  );
  const expectedMoves = snapshot.moves.map((source) => ({
    move_id: source.moveId,
    pp_current:
      wild.moves.find((move) => move.moveId === source.moveId)?.ppCurrent ?? source.ppCurrent,
  }));
  if (JSON.stringify(capturedMoves.rows) !== JSON.stringify(expectedMoves)) {
    throw new Error(
      `Captured Pokemon PP state diverged from battle snapshot: ${JSON.stringify({ actual: capturedMoves.rows, expected: expectedMoves })}`,
    );
  }

  const condition = await pool.query<{ condition_key: string }>(
    "SELECT condition_key FROM pokemon_persistent_conditions WHERE pokemon_instance_id = $1",
    [primary.pokemonInstanceId],
  );
  const expectedStatus = wild.majorStatus?.key ?? null;
  if (
    (expectedStatus === null && condition.rows.length !== 0) ||
    (expectedStatus !== null && condition.rows[0]?.condition_key !== expectedStatus)
  ) {
    throw new Error("Captured Pokemon persistent major status does not match battle snapshot");
  }

  const pokedex = await pool.query<{ caught_count: string }>(
    `SELECT caught_count::text FROM player_pokedex_species
     WHERE player_id = $1 AND species_id = $2`,
    [fixture.playerId, snapshot.speciesId],
  );
  if (Number(pokedex.rows[0]?.caught_count ?? "0") < 1) {
    throw new Error("Successful capture did not update Pokédex caught count");
  }
}

async function proveFailureReplay(pool: Pool, ballItemId: string): Promise<void> {
  const fixture = await prepareEngagedEncounter(
    pool,
    "capture-failure",
    "phase10-failure-encounter",
  );
  await setBallBalance(pool, fixture.playerId, ballItemId, 2);
  const service = () =>
    new CaptureService(
      new PostgresCaptureRepository(pool),
      new AesEncounterSeedProvider(CAPTURE_KEY, 2, () => Buffer.alloc(32, 0x02)),
    );
  const input = {
    playerId: fixture.playerId,
    encounterId: fixture.encounterId,
    expectedEncounterRevision: fixture.revision,
    expectedBattleVersion: null,
    ballItemId,
    idempotencyKey: "phase10-failure-replay",
    correlationId: createCorrelationId(),
    causationId: null,
  } as const;
  const failed = unwrap("deterministic failed capture", await service().attempt(input));
  if (failed.status !== "FAILED" || failed.replayed || failed.rollBasisPoints !== 9793) {
    throw new Error(`Capture failure was not deterministic: ${JSON.stringify(failed)}`);
  }
  const replay = unwrap("restart failed capture replay", await service().attempt(input));
  if (
    replay.status !== "FAILED" ||
    !replay.replayed ||
    replay.captureAttemptId !== failed.captureAttemptId ||
    replay.rollBasisPoints !== failed.rollBasisPoints
  ) {
    throw new Error("Restart replay did not return the durable failed capture result");
  }
  const audit = await pool.query<{
    attempts: string;
    ledger_rows: string;
    balance: string;
    outbox_rows: string;
    encounter_status: string;
    pokemon_rows: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM capture_attempts WHERE player_id = $1) AS attempts,
       (SELECT count(*)::text FROM inventory_ledger
         WHERE player_id = $1 AND idempotency_scope = 'capture.consume') AS ledger_rows,
       (SELECT quantity::text FROM inventory_balances WHERE player_id = $1 AND item_id = $2) AS balance,
       (SELECT count(*)::text FROM outbox_messages WHERE idempotency_key = $3) AS outbox_rows,
       (SELECT status FROM encounters WHERE id = $4) AS encounter_status,
       (SELECT count(*)::text FROM pokemon_instances
         WHERE owner_player_id = $1 AND origin_type = 'CAPTURE') AS pokemon_rows`,
    [
      fixture.playerId,
      ballItemId,
      `capture.result:${failed.captureAttemptId}`,
      fixture.encounterId,
    ],
  );
  const row = audit.rows[0];
  if (
    row === undefined ||
    row.attempts !== "1" ||
    row.ledger_rows !== "1" ||
    row.balance !== "1" ||
    row.outbox_rows !== "1" ||
    row.encounter_status !== "ENGAGED" ||
    row.pokemon_rows !== "0"
  ) {
    throw new Error(`Failed capture replay audit failed: ${JSON.stringify(row)}`);
  }
}

async function proveCrashRollback(pool: Pool, ballItemId: string): Promise<void> {
  const fixture = await prepareEngagedEncounter(pool, "capture-crash", "phase10-crash-encounter");
  await setBallBalance(pool, fixture.playerId, ballItemId, 1);
  const repository = new PostgresCaptureRepository(pool);
  const crashing = new CaptureService(
    new CrashAfterBallRepository(repository),
    new AesEncounterSeedProvider(CAPTURE_KEY, 2, () => Buffer.alloc(32, 0x00)),
  );
  const result = await crashing.attempt({
    playerId: fixture.playerId,
    encounterId: fixture.encounterId,
    expectedEncounterRevision: fixture.revision,
    expectedBattleVersion: null,
    ballItemId,
    idempotencyKey: "phase10-crash-after-ball",
    correlationId: createCorrelationId(),
    causationId: null,
    explicitModifierBasisPoints: [100_000],
  });
  if (result.ok)
    throw new Error("Injected post-Ball crash unexpectedly committed a capture result");

  const audit = await pool.query<{
    attempts: string;
    ledger_rows: string;
    balance: string;
    outbox_rows: string;
    encounter_status: string;
    encounter_revision: string;
    pokemon_rows: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM capture_attempts WHERE player_id = $1) AS attempts,
       (SELECT count(*)::text FROM inventory_ledger
         WHERE player_id = $1 AND idempotency_scope = 'capture.consume') AS ledger_rows,
       (SELECT quantity::text FROM inventory_balances WHERE player_id = $1 AND item_id = $2) AS balance,
       (SELECT count(*)::text FROM outbox_messages
         WHERE destination_ref = $1::text AND message_type = 'CAPTURE_RESULT') AS outbox_rows,
       (SELECT status FROM encounters WHERE id = $3) AS encounter_status,
       (SELECT revision::text FROM encounters WHERE id = $3) AS encounter_revision,
       (SELECT count(*)::text FROM pokemon_instances
         WHERE owner_player_id = $1 AND origin_type = 'CAPTURE') AS pokemon_rows`,
    [fixture.playerId, ballItemId, fixture.encounterId],
  );
  const row = audit.rows[0];
  if (
    row === undefined ||
    row.attempts !== "0" ||
    row.ledger_rows !== "0" ||
    row.balance !== "1" ||
    row.outbox_rows !== "0" ||
    row.encounter_status !== "ENGAGED" ||
    BigInt(row.encounter_revision) !== fixture.revision ||
    row.pokemon_rows !== "0"
  ) {
    throw new Error(`Injected crash did not roll back atomically: ${JSON.stringify(row)}`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 24 });
  try {
    const ballItemId = await pokeBallId(pool);
    await proveConcurrentBattleSuccess(pool, ballItemId);
    await proveFailureReplay(pool, ballItemId);
    await proveCrashRollback(pool, ballItemId);
    console.log(
      "Phase 10 Capture E2E complete: concurrent success converged, failure replayed, injected crash rolled back",
    );
  } finally {
    await pool.end();
  }
}

await main();
