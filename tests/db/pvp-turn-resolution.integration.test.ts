import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutoTurnDispatcher } from "../../src/modules/battle/auto-turn-dispatcher.js";
import type {
  BattleAction,
  BattleCombatant,
  BattleState,
} from "../../src/modules/battle/contracts.js";
import { PvpTurnResolutionService } from "../../src/modules/battle/pvp-turn-resolution.js";
import { BattleService } from "../../src/modules/battle/service.js";
import { PostgresAutoTurnWindowReader } from "../../src/platform/battle/postgres-auto-turn-window-reader.js";
import { PostgresBattleAftermath } from "../../src/platform/battle/postgres-battle-aftermath.js";
import { PostgresBattleCancellation } from "../../src/platform/battle/postgres-battle-cancellation.js";
import { PostgresBattleParticipantControllerRepository } from "../../src/platform/battle/postgres-battle-participant-controller-repository.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { PostgresPvpTurnResolutionRepository } from "../../src/platform/battle/postgres-pvp-turn-resolution-repository.js";
import { encryptRngSeed } from "../../src/platform/db/encrypted-seed.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { createPveBattleRuntime } from "../../src/runtime/compose-pve-battle-runtime.js";
import { playerCombatant, wildCombatant } from "../battle/fixtures.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

const RULESET_CONFIG = {
  schemaVersion: 1,
  battle: {
    statModel: "SIX_STATS",
    physicalSpecialByMove: true,
    ivEnabled: true,
    evEnabled: false,
    natureEnabled: true,
    maxMoves: 4,
    ppEnabled: true,
    criticalMultiplierBasisPoints: 15_000,
    accuracyEvasionEnabled: true,
    stabMultiplierBasisPoints: 15_000,
    damageRandomMinBasisPoints: 10_000,
    damageRandomMaxBasisPoints: 10_000,
    switchConsumesTurn: true,
  },
  capture: { model: "POKEMON_INSPIRED_V1", maxProbabilityBasisPoints: 10_000 },
  defeat: { automaticMoneyLoss: false },
  narrative: { authority: "N0_FLAVOR_ONLY" },
} as const;

interface Fixture {
  readonly battleId: string;
  readonly rulesetId: string;
  readonly releaseId: string;
  readonly playerA: string;
  readonly playerB: string;
  readonly actorA: string;
  readonly actorB: string;
  readonly state: BattleState;
  readonly windowId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function combatants(actorA: string, actorB: string): readonly [BattleCombatant, BattleCombatant] {
  const first = { ...playerCombatant(), participantId: actorA, pokemonInstanceId: randomUUID() };
  const secondBase = wildCombatant();
  const second: BattleCombatant = {
    ...secondBase,
    participantId: actorB,
    participantKind: "PLAYER_POKEMON",
    pokemonInstanceId: randomUUID(),
    level: first.level,
    baseStats: { ...first.baseStats },
    ivs: { ...first.ivs },
    nature: { ...first.nature },
  };
  return [first, second];
}

function stateFor(input: {
  readonly battleId: string;
  readonly rulesetId: string;
  readonly releaseId: string;
  readonly playerA: string;
  readonly playerB: string;
  readonly actorA: string;
  readonly actorB: string;
}): BattleState {
  const [first, second] = combatants(input.actorA, input.actorB);
  return {
    schemaVersion: 1,
    battleId: input.battleId,
    battleType: "PVP",
    status: "ACTIVE",
    contentReleaseId: input.releaseId,
    rulesetId: input.rulesetId,
    encounterId: null,
    turnNumber: 0,
    version: 0,
    rngCounter: "0",
    sides: [
      {
        sideNo: 1,
        controllerKind: "PLAYER",
        playerId: input.playerA,
        participantIds: [input.actorA],
        activeParticipantId: input.actorA,
        result: null,
      },
      {
        sideNo: 2,
        controllerKind: "PLAYER",
        playerId: input.playerB,
        participantIds: [input.actorB],
        activeParticipantId: input.actorB,
        result: null,
      },
    ],
    combatants: [first, second],
  };
}

function action(actorParticipantId: string, targetParticipantId: string): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId,
    targetParticipantId,
    moveSlot: 1,
  };
}

async function seedPersistedMovesForCombatant(
  pool: Pool,
  combatant: BattleCombatant,
): Promise<void> {
  if (combatant.pokemonInstanceId === null) {
    throw new Error("Persisted player fixture is missing its Pokemon instance");
  }

  for (const move of combatant.moves) {
    await pool.query(
      `INSERT INTO moves(id, slug)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [move.moveId, `pvp-resolution-move-${move.moveId}`],
    );
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pokemon_instance_id, slot_no)
       DO UPDATE SET move_id = EXCLUDED.move_id, pp_current = EXCLUDED.pp_current`,
      [combatant.pokemonInstanceId, move.slotNo, move.moveId, move.ppCurrent],
    );
  }
}

async function seedLockedFixture(
  pool: Pool,
  mode: "PVP" | "AUTO" | "NARRATOR" | "ALL_AUTO" = "PVP",
  open = true,
  forcedAutoSwitch = false,
  initializeThroughRepository: boolean | "DEFER" = false,
  autoPlayer = false,
  defeatWorld = false,
): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const playerA = randomUUID();
  const playerB = randomUUID();
  const battleId = randomUUID();
  const sideA = randomUUID();
  const sideB = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();
  const windowId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const baseState = stateFor({
    battleId,
    rulesetId,
    releaseId,
    playerA,
    playerB,
    actorA,
    actorB,
  });
  let state: BattleState =
    mode === "PVP"
      ? baseState
      : {
          ...baseState,
          battleType: "WILD",
          sides: baseState.sides.map((s) =>
            s.sideNo === 2 ? { ...s, controllerKind: "WILD", playerId: null } : s,
          ),
          combatants: baseState.combatants.map((c) =>
            c.sideNo === 2 ? { ...c, participantKind: "WILD_POKEMON", pokemonInstanceId: null } : c,
          ),
        };
  const reserveId = randomUUID();
  if (forcedAutoSwitch) {
    const wild = state.combatants[1];
    if (wild === undefined) throw new Error("Missing wild fixture actor");
    state = {
      ...state,
      sides: state.sides.map((s) =>
        s.sideNo === 2 ? { ...s, participantIds: [...s.participantIds, reserveId] } : s,
      ),
      combatants: [
        ...state.combatants.map((c) => (c.sideNo === 2 ? { ...c, currentHp: 0 } : c)),
        { ...wild, participantId: reserveId, rosterPosition: 2 },
      ],
    };
  }
  const pokemonA = state.combatants[0]?.pokemonInstanceId;
  const pokemonB = baseState.combatants[1]?.pokemonInstanceId;
  if (pokemonA === null || pokemonA === undefined || pokemonB === null || pokemonB === undefined) {
    throw new Error("PVP fixture combatants must have Pokemon instances");
  }

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, $3::jsonb, 'DRAFT')`,
    [rulesetId, `pvp-resolution-${rulesetId}`, JSON.stringify(RULESET_CONFIG)],
  );
  await pool.query(
    `UPDATE rulesets
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"test_fixture":true}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "0".repeat(64)],
  );
  await pool.query(`UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [
    rulesetId,
  ]);
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, $3, 'DRAFT', $4)`,
    [
      releaseId,
      Number.parseInt(releaseId.replaceAll("-", "").slice(0, 8), 16) + 1,
      `PVP ${battleId}`,
      rulesetId,
    ],
  );
  if (defeatWorld) {
    const regionId = randomUUID();
    const areaId = randomUUID();
    await pool.query("INSERT INTO regions(id,slug) VALUES ($1::uuid,$1::text)", [regionId]);
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,'safe')", [
      areaId,
      regionId,
    ]);
    await pool.query(
      `INSERT INTO area_revisions(id,content_release_id,area_id,display_name,data)
       VALUES ($1,$2,$3,'Safe', $4::jsonb)`,
      [
        randomUUID(),
        releaseId,
        areaId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "TOWN",
          safePoint: true,
          startingArea: false,
          relocationPriority: 0,
        }),
      ],
    );
  }
  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED',
         validated_at = now(),
         validation_report = '{"test_fixture":true}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "1".repeat(64)],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [releaseId],
  );
  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')`, [
    playerA,
    playerB,
  ]);
  await pool.query(
    `INSERT INTO pokemon_species(id, national_dex, slug)
     SELECT $1, COALESCE(MAX(national_dex), 0) + 1, $2
     FROM pokemon_species`,
    [speciesId, `pvp-resolution-species-${speciesId}`],
  );
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    formId,
    speciesId,
  ]);
  await pool.query(
    `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
     VALUES ($1, $2, $5, 10, $6, 'TEST'), ($3, $4, $5, 10, $7, 'TEST')`,
    [
      pokemonA,
      playerA,
      pokemonB,
      playerB,
      formId,
      state.combatants[0]?.currentHp ?? 1,
      state.combatants[1]?.currentHp ?? 1,
    ],
  );
  for (const combatant of state.combatants) {
    if (combatant.participantKind === "PLAYER_POKEMON") {
      await seedPersistedMovesForCombatant(pool, combatant);
    }
  }
  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv,
       rng_seed_auth_tag, rng_seed_key_version, rng_counter
     ) VALUES ($1, $7, 'ACTIVE', $2, $3, 0, 0, $4, $5, $6, 1, 0)`,
    [
      battleId,
      releaseId,
      rulesetId,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(16, 3),
      state.battleType,
    ],
  );
  if (initializeThroughRepository) {
    await pool.query("UPDATE battles SET status='CREATED' WHERE id=$1", [battleId]);
    if (initializeThroughRepository === "DEFER")
      return { battleId, rulesetId, releaseId, playerA, playerB, actorA, actorB, state, windowId };
    await new PostgresBattleRepository(pool, { turnWindowTtlMs: 300_000 }).transaction(
      async (tx) => {
        const root = await tx.loadRoot(battleId, true);
        if (root === null) throw new Error("Missing fixture root");
        await tx.initialize(root, state);
      },
    );
    return { battleId, rulesetId, releaseId, playerA, playerB, actorA, actorB, state, windowId };
  }
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $3, 1, 'PLAYER', $4), ($2, $3, 2, 'PLAYER', $5)`,
    [sideA, sideB, battleId, playerA, playerB],
  );
  await pool.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, active_member, snapshot
     ) VALUES
       ($1, $5, $3, $6, 'PLAYER_POKEMON', 1, TRUE, $8::jsonb),
       ($2, $5, $4, $7, 'PLAYER_POKEMON', 1, TRUE, $9::jsonb)`,
    [
      actorA,
      actorB,
      sideA,
      sideB,
      battleId,
      pokemonA,
      pokemonB,
      JSON.stringify(state.combatants[0]),
      JSON.stringify(state.combatants[1]),
    ],
  );
  if (forcedAutoSwitch)
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,participant_kind,roster_position,active_member,snapshot)
     VALUES ($1,$2,$3,'WILD_POKEMON',2,FALSE,$4::jsonb)`,
      [reserveId, battleId, sideB, JSON.stringify(state.combatants[2])],
    );
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 0, 1, $2::jsonb)`,
    [battleId, JSON.stringify(state)],
  );

  const turnWindows = new PostgresBattleTurnWindowRepository(pool);
  const narrator = randomUUID();
  if (mode !== "PVP") {
    await pool.query(
      "UPDATE battle_sides SET controller_kind='WILD',player_id=NULL WHERE battle_id=$1 AND side_no=2",
      [battleId],
    );
    await pool.query(
      "UPDATE battle_participants SET participant_kind='WILD_POKEMON',pokemon_instance_id=NULL WHERE id=$1",
      [actorB],
    );
    await pool.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1::uuid,$1::text,'ACTIVE')",
      [narrator],
    );
    const controllers = new PostgresBattleParticipantControllerRepository(pool);
    if (forcedAutoSwitch)
      await controllers.initialize({
        battleId,
        participantId: reserveId,
        kind: "AUTO",
        playerId: null,
        adminPrincipalId: null,
      });
    await controllers.initialize({
      battleId,
      participantId: actorA,
      kind: mode === "ALL_AUTO" || autoPlayer ? "AUTO" : "PLAYER",
      playerId: mode === "ALL_AUTO" || autoPlayer ? null : playerA,
      adminPrincipalId: null,
    });
    await controllers.initialize({
      battleId,
      participantId: actorB,
      kind: mode === "ALL_AUTO" ? "AUTO" : mode,
      playerId: null,
      adminPrincipalId: mode === "NARRATOR" ? narrator : null,
    });
  }
  const fixture = {
    battleId,
    rulesetId,
    releaseId,
    playerA,
    playerB,
    actorA,
    actorB,
    state,
    windowId,
  };
  if (!open) return fixture;
  const input = {
    id: windowId,
    battleId,
    battleVersion: 0,
    turnNumber: 0,
    openedAt: new Date("2026-08-31T13:00:00.000Z"),
    deadlineAt: new Date("2026-08-31T13:05:00.000Z"),
  };
  const opened =
    mode === "PVP"
      ? await turnWindows.open({
          ...input,
          requiredPlayers: [
            { playerId: playerA, sideNo: 1 },
            { playerId: playerB, sideNo: 2 },
          ],
        })
      : await turnWindows.openForControllers(input);
  if (!opened.ok) throw new Error(opened.error.message);

  if (mode === "ALL_AUTO" || forcedAutoSwitch) return fixture;
  const submittedA = await turnWindows.submit(windowId, {
    id: randomUUID(),
    playerId: playerA,
    ...(mode === "PVP" ? {} : { controllerRevision: 0 }),
    sideNo: 1,
    expectedBattleVersion: 0,
    idempotencyKey: `pvp-resolution-a-${battleId}`,
    action: action(actorA, actorB),
    submittedAt: new Date("2026-08-31T13:00:10.000Z"),
  });
  if (!submittedA.ok) throw new Error(submittedA.error.message);
  if (mode === "AUTO")
    return { battleId, rulesetId, releaseId, playerA, playerB, actorA, actorB, state, windowId };
  const submittedB = await turnWindows.submit(windowId, {
    id: randomUUID(),
    playerId: mode === "NARRATOR" ? null : playerB,
    ...(mode === "NARRATOR" ? { adminPrincipalId: narrator, controllerRevision: 0 } : {}),
    sideNo: 2,
    expectedBattleVersion: 0,
    idempotencyKey: `pvp-resolution-b-${battleId}`,
    action: action(actorB, actorA),
    submittedAt: new Date("2026-08-31T13:00:11.000Z"),
  });
  if (!submittedB.ok) throw new Error(submittedB.error.message);
  if (submittedB.value.aggregate.window.status !== "LOCKED") {
    throw new Error("PVP fixture did not lock its turn window");
  }

  return { battleId, rulesetId, releaseId, playerA, playerB, actorA, actorB, state, windowId };
}

function service(pool: Pool): PvpTurnResolutionService {
  return new PvpTurnResolutionService(
    new PostgresPvpTurnResolutionRepository(pool),
    { decrypt: () => new Uint8Array(32).fill(7) },
    randomUUID,
    () => new Date("2026-08-31T13:01:00.000Z"),
  );
}

async function resolutionCounts(pool: Pool, fixture: Fixture) {
  const [battle, snapshots, events, actions, window, submissions] = await Promise.all([
    pool.query<{ version: string; turn_number: number; rng_counter: string }>(
      `SELECT version::text, turn_number, rng_counter::text FROM battles WHERE id = $1`,
      [fixture.battleId],
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM battle_state_snapshots WHERE battle_id = $1`,
      [fixture.battleId],
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM battle_events WHERE battle_id = $1`,
      [fixture.battleId],
    ),
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM battle_actions WHERE battle_id = $1`,
      [fixture.battleId],
    ),
    pool.query<{
      status: string;
      resolved_battle_version: string | null;
      resolution_correlation_id: string | null;
    }>(
      `SELECT status, resolved_battle_version::text, resolution_correlation_id::text
       FROM battle_turn_windows WHERE id = $1`,
      [fixture.windowId],
    ),
    pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM battle_turn_submissions WHERE turn_window_id = $1
       GROUP BY status ORDER BY status`,
      [fixture.windowId],
    ),
  ]);
  return {
    battle: battle.rows[0],
    snapshots: snapshots.rows[0]?.count,
    events: events.rows[0]?.count,
    actions: actions.rows[0]?.count,
    window: window.rows[0],
    submissions: submissions.rows,
  };
}

describe("PVP turn resolution PostgreSQL integration", () => {
  const dbName = `pokemon_pvp_resolution_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "flow003-pvp-resolution-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool.end();
  }, 30_000);

  it("composes encrypted AUTO dispatch and resumes exactly one turn per maintenance tick", async () => {
    const fixture = await seedLockedFixture(pool, "ALL_AUTO");
    const encryptionKey = Buffer.alloc(32, 9);
    const envelope = encryptRngSeed(
      Buffer.alloc(32, 7),
      encryptionKey,
      3,
      Buffer.from(`battle:${fixture.battleId}`),
    );
    await pool.query(
      `UPDATE battles SET rng_seed_ciphertext=$2,rng_seed_iv=$3,rng_seed_auth_tag=$4,rng_seed_key_version=3 WHERE id=$1`,
      [fixture.battleId, envelope.ciphertext, envelope.iv, envelope.authTag],
    );
    const config = {
      turnWindowTtlMs: 300_000,
      maintenanceBatchSize: 1,
      encryptionKeys: new Map([[3, encryptionKey]]),
    };
    const first = await createPveBattleRuntime(pool, config).runMaintenance();
    expect(first.turns).toMatchObject([
      { windowId: fixture.windowId, result: { ok: true, value: { state: { version: 1 } } } },
    ]);
    const restarted = createPveBattleRuntime(pool, config);
    expect((await restarted.runMaintenance()).turns).toMatchObject([
      { result: { ok: true, value: { state: { version: 2 } } } },
    ]);
    expect(await restarted.battle.currentState(fixture.battleId)).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
  });

  it("queues terminal defeat atomically and retries aftermath after restart without relocating twice", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", true, false, false, false, true);
    const state = structuredClone(fixture.state);
    const player = state.combatants[0];
    const wild = state.combatants[1];
    if (player === undefined || wild === undefined) throw new Error("Missing defeat actors");
    player.currentHp = 1;
    player.majorStatus = { key: "POISON", counter: null };
    const side = state.sides[0];
    const owned = await pool.query<{ id: string }>(
      "SELECT id FROM pokemon_instances WHERE owner_player_id=$1",
      [fixture.playerB],
    );
    const pokemonId = owned.rows[0]?.id;
    if (side === undefined || pokemonId === undefined)
      throw new Error("Missing defeated ally fixture");
    const ally = {
      ...structuredClone(player),
      participantId: randomUUID(),
      pokemonInstanceId: pokemonId,
      currentHp: 0,
      majorStatus: null,
      rosterPosition: 2,
    };
    await seedPersistedMovesForCombatant(pool, ally);
    side.participantIds.push(ally.participantId);
    side.slots = [
      { activeParticipantId: player.participantId, participantIds: [player.participantId] },
      { activeParticipantId: ally.participantId, participantIds: [ally.participantId] },
    ];
    state.combatants.push(ally);
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,pokemon_instance_id,participant_kind,roster_position,active_member,snapshot)
      SELECT $1,$2,id,$3,'PLAYER_POKEMON',2,TRUE,$4::jsonb FROM battle_sides WHERE battle_id=$2 AND side_no=1`,
      [ally.participantId, fixture.battleId, pokemonId, JSON.stringify(ally)],
    );
    await new PostgresBattleParticipantControllerRepository(pool).initialize({
      battleId: fixture.battleId,
      participantId: ally.participantId,
      kind: "PLAYER",
      playerId: fixture.playerB,
      adminPrincipalId: null,
    });
    wild.currentHp = wild.maxHp;
    wild.baseStats.speed = 255;
    await pool.query("UPDATE battle_state_snapshots SET state=$2::jsonb WHERE battle_id=$1", [
      fixture.battleId,
      JSON.stringify(state),
    ]);
    const trigger = `reject_aftermath_${fixture.battleId.replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.battle_id = '${fixture.battleId}'::uuid THEN RAISE EXCEPTION 'forced aftermath enqueue failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON battle_defeat_aftermath FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    const before = await resolutionCounts(pool, fixture);
    await expect(service(pool).resolve(fixture.windowId)).rejects.toThrow(
      "forced aftermath enqueue failure",
    );
    expect(await resolutionCounts(pool, fixture)).toEqual(before);
    await pool.query(`DROP TRIGGER ${trigger} ON battle_defeat_aftermath`);
    expect(await service(pool).resolve(fixture.windowId)).toMatchObject({
      ok: true,
      value: { state: { status: "LOST" } },
    });
    const failed = await new PostgresBattleAftermath(pool).runOnce(100);
    expect(failed).toContainEqual({
      battleId: fixture.battleId,
      error: expect.objectContaining({
        message: "Defeated player has no persisted world location",
      }),
    });
    const safe = await pool.query<{ area_id: string; region_id: string }>(
      "SELECT r.area_id,a.region_id FROM area_revisions r JOIN areas a ON a.id=r.area_id WHERE r.content_release_id=$1",
      [fixture.releaseId],
    );
    const destination = safe.rows[0];
    if (destination === undefined) throw new Error("Missing safe point");
    const routeId = randomUUID();
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,'route')", [
      routeId,
      destination.region_id,
    ]);
    const [firstOwner, secondOwner] = [fixture.playerA, fixture.playerB].sort();
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [
      firstOwner,
      routeId,
    ]);
    expect(await new PostgresBattleAftermath(pool).runOnce(100)).toContainEqual({
      battleId: fixture.battleId,
      error: expect.any(Error),
    });
    expect(
      (
        await pool.query("SELECT area_id,revision FROM player_locations WHERE player_id=$1", [
          firstOwner,
        ])
      ).rows,
    ).toEqual([{ area_id: routeId, revision: "0" }]);
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [
      secondOwner,
      routeId,
    ]);
    const outcomes = await Promise.all([
      new PostgresBattleAftermath(pool).runOnce(100),
      new PostgresBattleAftermath(pool).runOnce(100),
    ]);
    expect(
      outcomes
        .flat()
        .filter((entry) => entry.battleId === fixture.battleId)
        .every((entry) => !("error" in entry)),
    ).toBe(true);
    expect(
      (
        await pool.query("SELECT area_id,revision FROM player_locations WHERE player_id=$1", [
          fixture.playerA,
        ])
      ).rows,
    ).toEqual([{ area_id: destination.area_id, revision: "1" }]);
    expect(
      (
        await pool.query("SELECT area_id,revision FROM player_locations WHERE player_id=$1", [
          fixture.playerB,
        ])
      ).rows,
    ).toEqual([{ area_id: destination.area_id, revision: "1" }]);
    // A completed delivery must never drag a player back after they leave the safe point.
    await pool.query("UPDATE player_locations SET area_id=$2 WHERE player_id=$1", [
      fixture.playerA,
      routeId,
    ]);
    const replay = await service(pool).resolve(fixture.windowId);
    if (!replay.ok) throw replay.error;
    await new PostgresBattleAftermath(pool).applyDefeat(replay.value.state);
    expect(
      (
        await pool.query("SELECT area_id FROM player_locations WHERE player_id=$1", [
          fixture.playerA,
        ])
      ).rows[0]?.area_id,
    ).toBe(routeId);
    expect(
      (await new PostgresBattleAftermath(pool).runOnce(100)).some(
        (entry) => entry.battleId === fixture.battleId,
      ),
    ).toBe(false);
  });

  it.each(["AUTO", "NARRATOR"] as const)(
    "resolves two allied PLAYER slots against %s after partial restart",
    async (mode) => {
      const fixture = await seedLockedFixture(pool, mode, false);
      const state = structuredClone(fixture.state);
      const side = state.sides[0];
      const source = state.combatants[0];
      if (side === undefined || source === undefined) throw new Error("Missing allied fixture");
      const allyId = randomUUID();
      const owned = await pool.query<{ id: string }>(
        "SELECT id FROM pokemon_instances WHERE owner_player_id=$1",
        [fixture.playerB],
      );
      const pokemonId = owned.rows[0]?.id;
      if (pokemonId === undefined) throw new Error("Missing ally Pokemon");
      const ally = {
        ...source,
        participantId: allyId,
        rosterPosition: 2,
        pokemonInstanceId: pokemonId,
      };
      const reserveId = randomUUID();
      const reservePokemonId = randomUUID();
      const reserve = {
        ...ally,
        participantId: reserveId,
        rosterPosition: 3,
        pokemonInstanceId: reservePokemonId,
      };
      await pool.query(
        `INSERT INTO pokemon_instances(id,owner_player_id,form_id,level,current_hp,origin_type)
       SELECT $1,owner_player_id,form_id,level,current_hp,'TEST' FROM pokemon_instances WHERE id=$2`,
        [reservePokemonId, pokemonId],
      );
      await seedPersistedMovesForCombatant(pool, ally);
      await seedPersistedMovesForCombatant(pool, reserve);
      side.participantIds.push(allyId, reserveId);
      side.slots = [
        { activeParticipantId: fixture.actorA, participantIds: [fixture.actorA] },
        { activeParticipantId: allyId, participantIds: [allyId, reserveId] },
      ];
      state.combatants.push(ally, reserve);
      for (const actor of state.combatants) actor.currentHp = actor.maxHp = 500;
      await pool.query(
        `INSERT INTO battle_participants(id,battle_id,battle_side_id,pokemon_instance_id,participant_kind,roster_position,active_member,snapshot)
       SELECT $1,$2,id,$4,'PLAYER_POKEMON',2,TRUE,$3::jsonb FROM battle_sides WHERE battle_id=$2 AND side_no=1`,
        [allyId, fixture.battleId, JSON.stringify(ally), pokemonId],
      );
      await pool.query(
        `INSERT INTO battle_participants(id,battle_id,battle_side_id,pokemon_instance_id,participant_kind,roster_position,active_member,snapshot)
       SELECT $1,$2,id,$4,'PLAYER_POKEMON',3,FALSE,$3::jsonb FROM battle_sides WHERE battle_id=$2 AND side_no=1`,
        [reserveId, fixture.battleId, JSON.stringify(reserve), reservePokemonId],
      );
      await new PostgresBattleParticipantControllerRepository(pool).initialize({
        battleId: fixture.battleId,
        participantId: reserveId,
        kind: "PLAYER",
        playerId: fixture.playerB,
        adminPrincipalId: null,
      });
      await pool.query(
        "UPDATE battle_state_snapshots SET state=$2::jsonb WHERE battle_id=$1 AND version=0",
        [fixture.battleId, JSON.stringify(state)],
      );
      await new PostgresBattleParticipantControllerRepository(pool).initialize({
        battleId: fixture.battleId,
        participantId: allyId,
        kind: "PLAYER",
        playerId: fixture.playerB,
        adminPrincipalId: null,
      });
      const windows = new PostgresBattleTurnWindowRepository(pool);
      const opened = await windows.openForControllers({
        id: fixture.windowId,
        battleId: fixture.battleId,
        battleVersion: 0,
        turnNumber: 0,
        openedAt: new Date("2026-08-31T13:00:00Z"),
        deadlineAt: new Date("2026-08-31T13:05:00Z"),
      });
      if (!opened.ok) throw opened.error;
      expect(
        opened.value.aggregate.window.requiredControllers
          ?.filter((r) => r.sideNo === 1)
          .map((r) => r.playerId),
      ).toEqual([fixture.playerA, fixture.playerB]);
      for (const [participantId, playerId] of [
        [allyId, fixture.playerB],
        [fixture.actorA, fixture.playerA],
      ] as const) {
        const submitted = await new PostgresBattleTurnWindowRepository(pool).submit(
          fixture.windowId,
          {
            id: randomUUID(),
            playerId,
            sideNo: 1,
            controllerRevision: 0,
            expectedBattleVersion: 0,
            idempotencyKey: randomUUID(),
            action: action(participantId, fixture.actorB),
            submittedAt: new Date("2026-08-31T13:00:10Z"),
          },
        );
        if (!submitted.ok) throw submitted.error;
        if (participantId === allyId) {
          expect(submitted.value.aggregate.window.status).toBe("COLLECTING");
          expect(await service(pool).resolve(fixture.windowId)).toMatchObject({ ok: false });
        }
      }
      if (mode === "NARRATOR") {
        expect(await service(pool).resolve(fixture.windowId)).toMatchObject({ ok: false });
        const narrator = opened.value.aggregate.window.requiredControllers?.find(
          (r) => r.kind === "NARRATOR",
        );
        if (narrator === undefined) throw new Error("Missing narrator");
        const submitted = await windows.submit(fixture.windowId, {
          id: randomUUID(),
          playerId: null,
          adminPrincipalId: narrator.adminPrincipalId,
          sideNo: 2,
          controllerRevision: narrator.revision,
          expectedBattleVersion: 0,
          idempotencyKey: randomUUID(),
          action: action(fixture.actorB, allyId),
          submittedAt: new Date("2026-08-31T13:00:11Z"),
        });
        if (!submitted.ok) throw submitted.error;
      }
      const resolved = await service(pool).resolve(fixture.windowId);
      if (!resolved.ok) throw resolved.error;
      expect(resolved.value.state.sides).toHaveLength(2);
      expect(resolved.value.events.filter((e) => e.type === "MoveUsed")).toHaveLength(3);
      expect(await service(pool).resolve(fixture.windowId)).toMatchObject({
        ok: true,
        value: { replayed: true },
      });
      const next = await new PostgresBattleTurnWindowRepository(pool).loadByBattleVersion(
        fixture.battleId,
        1,
      );
      if (!next.ok) throw next.error;
      expect(next.value.window.requiredControllers?.filter((r) => r.sideNo === 1)).toHaveLength(2);
      // A fresh repository resolves a switch in the second allied slot; the next
      // durable window must transfer only that slot's required actor to its reserve.
      for (const required of next.value.window.requiredControllers ?? []) {
        const submitted = await new PostgresBattleTurnWindowRepository(pool).submit(
          next.value.window.id,
          {
            id: randomUUID(),
            playerId: required.playerId,
            adminPrincipalId: required.adminPrincipalId,
            sideNo: required.sideNo,
            controllerRevision: required.revision,
            expectedBattleVersion: 1,
            idempotencyKey: randomUUID(),
            submittedAt: new Date("2026-08-31T13:01:10Z"),
            action:
              required.participantId === allyId
                ? { type: "SWITCH", actorParticipantId: allyId, switchToParticipantId: reserveId }
                : action(
                    required.participantId,
                    required.sideNo === 1 ? fixture.actorB : fixture.actorA,
                  ),
          },
        );
        if (!submitted.ok) throw submitted.error;
      }
      const switched = await service(pool).resolve(next.value.window.id);
      if (!switched.ok) throw switched.error;
      expect(switched.value.state.sides[0]?.slots?.map((slot) => slot.activeParticipantId)).toEqual(
        [fixture.actorA, reserveId],
      );
      expect(switched.value.state.sides).toHaveLength(2);
      const reloaded = await new PostgresBattleTurnWindowRepository(pool).loadByBattleVersion(
        fixture.battleId,
        2,
      );
      if (!reloaded.ok) throw reloaded.error;
      expect(reloaded.value.window.requiredControllers?.filter((r) => r.sideNo === 1)).toEqual([
        expect.objectContaining({ participantId: fixture.actorA, playerId: fixture.playerA }),
        expect.objectContaining({ participantId: reserveId, playerId: fixture.playerB }),
      ]);
    },
  );

  it("forces one allied AUTO slot, then refreshes only the required narrator actor", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false, true);
    const state = structuredClone(fixture.state);
    const side = state.sides[1];
    const source = state.combatants[1];
    const reserve = state.combatants[2];
    if (side === undefined || source === undefined || reserve === undefined)
      throw new Error("Missing forced fixture");
    const allyId = randomUUID();
    const ally = { ...source, participantId: allyId, rosterPosition: 3, currentHp: source.maxHp };
    side.slots = [
      { activeParticipantId: fixture.actorB, participantIds: [...side.participantIds] },
      { activeParticipantId: allyId, participantIds: [allyId] },
    ];
    side.participantIds.push(allyId);
    state.combatants.push(ally);
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,participant_kind,roster_position,active_member,snapshot)
       SELECT $1,$2,id,'WILD_POKEMON',3,TRUE,$3::jsonb FROM battle_sides WHERE battle_id=$2 AND side_no=2`,
      [allyId, fixture.battleId, JSON.stringify(ally)],
    );
    await pool.query(
      "UPDATE battle_state_snapshots SET state=$2::jsonb WHERE battle_id=$1 AND version=0",
      [fixture.battleId, JSON.stringify(state)],
    );
    const controllers = new PostgresBattleParticipantControllerRepository(pool);
    await controllers.initialize({
      battleId: fixture.battleId,
      participantId: allyId,
      kind: "AUTO",
      playerId: null,
      adminPrincipalId: null,
    });
    const windows = new PostgresBattleTurnWindowRepository(pool);
    const now = new Date();
    const opened = await windows.openForControllers({
      id: fixture.windowId,
      battleId: fixture.battleId,
      battleVersion: 0,
      turnNumber: 0,
      openedAt: now,
      deadlineAt: new Date(now.getTime() + 300_000),
    });
    expect(opened).toMatchObject({
      ok: true,
      value: { aggregate: { window: { status: "LOCKED", requiredControllers: [] } } },
    });
    const resolver = () =>
      new PvpTurnResolutionService(new PostgresPvpTurnResolutionRepository(pool), {
        decrypt: () => Buffer.alloc(32, 7),
      });
    const resolved = await resolver().resolve(fixture.windowId);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.events.filter((e) => e.type === "Switched")).toHaveLength(1);
    expect(resolved.value.state.sides[1]?.slots?.map((slot) => slot.activeParticipantId)).toEqual([
      reserve.participantId,
      allyId,
    ]);
    const next = await windows.loadByBattleVersion(fixture.battleId, 1);
    if (!next.ok) throw next.error;
    expect(next.value.window.requiredControllers).toHaveLength(1);
    const narrator = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1::uuid,$1::text,'ACTIVE')",
      [narrator],
    );
    expect(
      await controllers.transition({
        participantId: allyId,
        expectedRevision: 0,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).not.toBeNull();
    const refreshed = await new PostgresBattleTurnWindowRepository(pool).loadByBattleVersion(
      fixture.battleId,
      1,
    );
    if (!refreshed.ok) throw refreshed.error;
    expect(refreshed.value.window.requiredControllers).toEqual([
      expect.objectContaining({ participantId: fixture.actorA, kind: "PLAYER" }),
      expect.objectContaining({ participantId: allyId, kind: "NARRATOR", revision: 1 }),
    ]);
    expect(
      await controllers.transition({
        participantId: allyId,
        expectedRevision: 1,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).not.toBeNull();
    const restored = await windows.loadByBattleVersion(fixture.battleId, 1);
    if (!restored.ok) throw restored.error;
    expect(restored.value.window.requiredControllers).toHaveLength(1);
  });

  it("initializes PVE controllers and window atomically, then resolves through BattleService", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false, false, true);
    const windows = new PostgresBattleTurnWindowRepository(pool);
    const opened = await windows.loadByBattleVersion(fixture.battleId, 0);
    expect(opened).toMatchObject({
      ok: true,
      value: {
        window: {
          status: "COLLECTING",
          requiredControllers: [{ participantId: fixture.actorA, kind: "PLAYER" }],
        },
      },
    });
    const controllers = new PostgresBattleParticipantControllerRepository(pool);
    expect(await controllers.listByBattle(fixture.battleId)).toHaveLength(2);
    const core = () =>
      new BattleService(new PostgresBattleRepository(pool), { decrypt: () => Buffer.alloc(32, 7) });
    const input = {
      battleId: fixture.battleId,
      playerId: fixture.playerA,
      expectedVersion: 0,
      idempotencyKey: `runtime-${fixture.battleId}`,
      action: action(fixture.actorA, fixture.actorB),
    };
    expect(await core().resolvePlayerTurn(input)).toMatchObject({
      ok: true,
      value: { state: { version: 1 }, replayed: false },
    });
    expect(await windows.loadByBattleVersion(fixture.battleId, 0)).toMatchObject({
      ok: true,
      value: { window: { status: "COMMITTED" }, submissions: [{ status: "COMMITTED" }] },
    });
    expect(await core().resolvePlayerTurn(input)).toMatchObject({
      ok: true,
      value: { state: { version: 1 }, replayed: true },
    });
    expect(await core().resolvePlayerTurn({ ...input, playerId: fixture.playerB })).toMatchObject({
      ok: false,
    });
    expect(await windows.loadByBattleVersion(fixture.battleId, 1)).toMatchObject({
      ok: true,
      value: { window: { status: "COLLECTING" } },
    });
  });

  it("keeps a PVE player action pending after narrator takeover without consuming RNG", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false, false, true);
    const narrator = randomUUID();
    await pool.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1::uuid,$1::text,'ACTIVE')",
      [narrator],
    );
    const controllers = new PostgresBattleParticipantControllerRepository(pool);
    expect(
      await controllers.transition({
        participantId: fixture.actorB,
        expectedRevision: 0,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).not.toBeNull();
    const core = new BattleService(new PostgresBattleRepository(pool), {
      decrypt: () => {
        throw new Error("RNG must wait");
      },
    });
    expect(
      await core.resolvePlayerTurn({
        battleId: fixture.battleId,
        playerId: fixture.playerA,
        expectedVersion: 0,
        idempotencyKey: `pending-${fixture.battleId}`,
        action: action(fixture.actorA, fixture.actorB),
      }),
    ).toMatchObject({ ok: true, value: { pending: true, events: [], state: { version: 0 } } });
    expect(
      (
        await pool.query("SELECT version::text,rng_counter::text FROM battles WHERE id=$1", [
          fixture.battleId,
        ])
      ).rows,
    ).toEqual([{ version: "0", rng_counter: "0" }]);
    const replayInput = {
      battleId: fixture.battleId,
      playerId: fixture.playerA,
      expectedVersion: 0,
      idempotencyKey: `pending-${fixture.battleId}`,
      action: action(fixture.actorA, fixture.actorB),
    };
    const restarted = new BattleService(new PostgresBattleRepository(pool), {
      decrypt: () => {
        throw new Error("Pending replay must not use RNG");
      },
    });
    expect(await restarted.resolvePlayerTurn(replayInput)).toMatchObject({
      ok: true,
      value: { pending: true, replayed: true },
    });
    const windows = new PostgresBattleTurnWindowRepository(pool);
    const partial = await windows.loadByBattleVersion(fixture.battleId, 0);
    if (!partial.ok) throw new Error(partial.error.message);
    expect(partial.value.submissions).toHaveLength(1);
    expect(
      await windows.submit(partial.value.window.id, {
        id: randomUUID(),
        playerId: null,
        adminPrincipalId: narrator,
        controllerRevision: 1,
        sideNo: 2,
        expectedBattleVersion: 0,
        idempotencyKey: `narrator-${fixture.battleId}`,
        action: action(fixture.actorB, fixture.actorA),
        submittedAt: new Date(),
      }),
    ).toMatchObject({ ok: true, value: { aggregate: { window: { status: "LOCKED" } } } });
    const completed = await new PvpTurnResolutionService(
      new PostgresPvpTurnResolutionRepository(pool),
      {
        decrypt: () => Buffer.alloc(32, 7),
      },
    ).resolve(partial.value.window.id);
    expect(completed).toMatchObject({ ok: true, value: { state: { version: 1 } } });
    expect(await restarted.resolvePlayerTurn(replayInput)).toMatchObject({
      ok: true,
      value: { replayed: true, state: { version: 1 } },
    });
  });

  it("rolls back initial participants and controllers if window opening fails", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false, false, "DEFER");
    const initialize = () =>
      new PostgresBattleRepository(pool, { turnWindowTtlMs: 300_000 }).transaction(async (tx) => {
        const root = await tx.loadRoot(fixture.battleId, true);
        if (root === null) throw new Error("Missing root");
        return tx.initialize(root, fixture.state);
      });
    await pool.query(`CREATE FUNCTION reject_initial_window() RETURNS trigger AS $$ BEGIN
      IF NEW.battle_id = '${fixture.battleId}'::uuid THEN RAISE EXCEPTION 'forced initial window failure'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER reject_initial_window_trigger BEFORE INSERT ON battle_turn_windows FOR EACH ROW EXECUTE FUNCTION reject_initial_window()",
    );
    try {
      await expect(initialize()).rejects.toThrow("forced initial window failure");
      expect(
        (
          await pool.query("SELECT status, version::text FROM battles WHERE id=$1", [
            fixture.battleId,
          ])
        ).rows,
      ).toEqual([{ status: "CREATED", version: "0" }]);
      for (const table of [
        "battle_sides",
        "battle_participants",
        "battle_participant_controllers",
        "battle_participant_controller_events",
        "battle_state_snapshots",
        "battle_turn_windows",
      ]) {
        expect(
          (
            await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE battle_id=$1`, [
              fixture.battleId,
            ])
          ).rows[0]?.count,
        ).toBe(0);
      }
    } finally {
      await pool.query("DROP TRIGGER reject_initial_window_trigger ON battle_turn_windows");
      await pool.query("DROP FUNCTION reject_initial_window()");
    }
    await initialize();
    await initialize();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM battle_participant_controller_events WHERE battle_id=$1",
          [fixture.battleId],
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM battle_turn_windows WHERE battle_id=$1",
          [fixture.battleId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("validates before collection and rolls back the runtime submission when AUTO RNG fails", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false, false, true);
    let rngCalls = 0;
    const core = new BattleService(new PostgresBattleRepository(pool), {
      decrypt: () => {
        rngCalls += 1;
        throw new Error("test seed unavailable");
      },
    });
    const input = {
      battleId: fixture.battleId,
      playerId: fixture.playerA,
      expectedVersion: 0,
      idempotencyKey: `failed-runtime-${fixture.battleId}`,
      action: action(fixture.actorA, fixture.actorB),
    };
    expect(
      await core.resolvePlayerTurn({
        ...input,
        action: {
          type: "USE_MOVE",
          actorParticipantId: fixture.actorA,
          targetParticipantId: randomUUID(),
          moveSlot: 4,
        },
      }),
    ).toMatchObject({ ok: false });
    expect(rngCalls).toBe(0);
    expect(await core.resolvePlayerTurn(input)).toMatchObject({
      ok: false,
      error: { code: "BATTLE_RNG_UNAVAILABLE" },
    });
    expect(rngCalls).toBe(1);
    const windows = new PostgresBattleTurnWindowRepository(pool);
    expect(await windows.loadByBattleVersion(fixture.battleId, 0)).toMatchObject({
      ok: true,
      value: { window: { status: "COLLECTING", revision: 0 }, submissions: [] },
    });
    const retry = () =>
      new BattleService(new PostgresBattleRepository(pool), {
        decrypt: () => Buffer.alloc(32, 7),
      }).resolvePlayerTurn(input);
    const results = await Promise.all([retry(), retry()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(await retry()).toMatchObject({
      ok: true,
      value: { replayed: true, state: { version: 1 } },
    });
    expect(
      (
        await pool.query("SELECT count(*)::int AS count FROM battle_actions WHERE battle_id=$1", [
          fixture.battleId,
        ])
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("derives all humans, replays after restart and rejects stale or controller-less creation", async () => {
    const fixture = await seedLockedFixture(pool, "NARRATOR", false);
    const input = {
      id: fixture.windowId,
      battleId: fixture.battleId,
      battleVersion: 0,
      turnNumber: 0,
      openedAt: new Date("2026-08-31T13:00:00.000Z"),
      deadlineAt: new Date("2026-08-31T13:05:00.000Z"),
    };
    const repo = new PostgresBattleTurnWindowRepository(pool);
    expect((await repo.openForControllers({ ...input, turnNumber: 1 })).ok).toBe(false);
    expect((await repo.openForControllers({ ...input, battleVersion: 1 })).ok).toBe(false);
    const opened = await repo.openForControllers(input);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.aggregate.window.requiredControllers?.map((c) => c.kind)).toEqual([
      "PLAYER",
      "NARRATOR",
    ]);
    expect(opened.value.aggregate.window.status).toBe("COLLECTING");
    expect(
      await new PostgresBattleTurnWindowRepository(pool).openForControllers({
        ...input,
        id: randomUUID(),
      }),
    ).toEqual({ ok: true, value: { ...opened.value, replayed: true } });
    const missing = await seedLockedFixture(pool, "PVP", false);
    expect(
      (
        await repo.openForControllers({
          ...input,
          id: missing.windowId,
          battleId: missing.battleId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await pool.query("SELECT id FROM battle_turn_windows WHERE battle_id=$1", [
          missing.battleId,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it.each(["reserve", "idle"] as const)(
    "keeps a swapped %s controller out of the forced-switch requirements",
    async (actorKind) => {
      const fixture = await seedLockedFixture(pool, "NARRATOR", false, true, false, true);
      const windows = new PostgresBattleTurnWindowRepository(pool);
      expect(
        await windows.openForControllers({
          id: fixture.windowId,
          battleId: fixture.battleId,
          battleVersion: 0,
          turnNumber: 0,
          openedAt: new Date(),
          deadlineAt: new Date(Date.now() + 60000),
        }),
      ).toMatchObject({ ok: true });
      const controllers = new PostgresBattleParticipantControllerRepository(pool);
      const narrator = await controllers.get(fixture.actorB);
      if (narrator?.adminPrincipalId === null || narrator === null)
        throw new Error("Missing narrator");
      const reserve = fixture.state.combatants[2];
      if (reserve === undefined) throw new Error("Missing reserve");
      const participantId = actorKind === "reserve" ? reserve.participantId : fixture.actorA;
      const before = await windows.loadByBattleVersion(fixture.battleId, 0);
      if (!before.ok) throw before.error;
      expect(before.value.window.requiredControllers).toHaveLength(1);
      for (const [expectedRevision, kind] of [
        [0, "NARRATOR"],
        [1, "AUTO"],
        [2, "NARRATOR"],
      ] as const) {
        expect(
          await controllers.transition({
            participantId,
            expectedRevision,
            kind,
            adminPrincipalId: kind === "NARRATOR" ? narrator.adminPrincipalId : null,
          }),
        ).toMatchObject({ revision: expectedRevision + 1 });
        const after = await windows.loadByBattleVersion(fixture.battleId, 0);
        if (!after.ok) throw after.error;
        expect(after.value.window.requiredControllers).toEqual(
          before.value.window.requiredControllers,
        );
        expect(after.value.window.status).toBe("COLLECTING");
      }
      expect(
        await windows.submit(fixture.windowId, {
          id: randomUUID(),
          playerId: null,
          adminPrincipalId: narrator.adminPrincipalId,
          controllerRevision: 0,
          sideNo: 2,
          expectedBattleVersion: 0,
          idempotencyKey: randomUUID(),
          submittedAt: new Date(),
          action: {
            type: "SWITCH",
            actorParticipantId: fixture.actorB,
            switchToParticipantId: reserve.participantId,
          },
        }),
      ).toMatchObject({ ok: true, value: { aggregate: { window: { status: "LOCKED" } } } });
      expect(await service(pool).resolve(fixture.windowId)).toMatchObject({ ok: true });
      const next = await windows.loadByBattleVersion(fixture.battleId, 1);
      if (!next.ok) throw next.error;
      expect(next.value.window.requiredControllers).toEqual([
        expect.objectContaining({ participantId, kind: "NARRATOR", revision: 3 }),
      ]);
    },
  );

  it("dispatches a bounded AUTO turn, resumes after restart and retries RNG failures", async () => {
    const fixture = await seedLockedFixture(pool, "ALL_AUTO");
    const input = { battleId: fixture.battleId, limit: 1 };
    const reader = new PostgresAutoTurnWindowReader(pool);
    const broken = new AutoTurnDispatcher(
      reader,
      new PvpTurnResolutionService(new PostgresPvpTurnResolutionRepository(pool), {
        decrypt: () => {
          throw new Error("key unavailable");
        },
      }),
    );
    const before = await resolutionCounts(pool, fixture);
    expect(await broken.runOnce(input)).toMatchObject([
      {
        windowId: fixture.windowId,
        result: { ok: false, error: { code: "BATTLE_RNG_UNAVAILABLE" } },
      },
    ]);
    expect(await resolutionCounts(pool, fixture)).toEqual(before);
    expect(await reader.listLockedAutoWindows(input)).toEqual([fixture.windowId]);

    const fresh = () =>
      new AutoTurnDispatcher(new PostgresAutoTurnWindowReader(pool), service(pool));
    expect(await fresh().runOnce(input)).toMatchObject([
      { result: { ok: true, value: { state: { version: 1 }, replayed: false } } },
    ]);
    expect((await resolutionCounts(pool, fixture)).battle?.version).toBe("1");
    const nextIds = await reader.listLockedAutoWindows(input);
    expect(nextIds).toHaveLength(1);
    expect(nextIds[0]).not.toBe(fixture.windowId);
    // Both workers discover the same durable window before either resolves it.
    const discovered = { listLockedAutoWindows: async () => nextIds };
    const raced = await Promise.all([
      new AutoTurnDispatcher(discovered, service(pool)).runOnce(input),
      new AutoTurnDispatcher(discovered, service(pool)).runOnce(input),
    ]);
    expect(
      raced
        .flat()
        .map((outcome) => "result" in outcome && outcome.result.ok && outcome.result.value.replayed)
        .sort(),
    ).toEqual([false, true]);
    expect((await resolutionCounts(pool, fixture)).battle?.version).toBe("2");
  });

  it("does not dispatch collecting, human, legacy, stale or terminal windows", async () => {
    const reader = new PostgresAutoTurnWindowReader(pool);
    for (const mode of ["AUTO", "NARRATOR", "PVP"] as const) {
      const fixture = await seedLockedFixture(pool, mode);
      expect(await reader.listLockedAutoWindows({ battleId: fixture.battleId, limit: 10 })).toEqual(
        [],
      );
    }
    const stale = await seedLockedFixture(pool, "ALL_AUTO");
    await pool.query("UPDATE battles SET version=version+1 WHERE id=$1", [stale.battleId]);
    expect(await reader.listLockedAutoWindows({ battleId: stale.battleId, limit: 10 })).toEqual([]);
    const terminal = await seedLockedFixture(pool, "ALL_AUTO");
    await pool.query("UPDATE battles SET status='CANCELLED', ended_at=now() WHERE id=$1", [
      terminal.battleId,
    ]);
    expect(await reader.listLockedAutoWindows({ battleId: terminal.battleId, limit: 10 })).toEqual(
      [],
    );
  });

  it("resolves an AUTO forced switch without waiting for an idle player, then requires that player again", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", true, true);
    const repo = new PostgresBattleTurnWindowRepository(pool);
    expect(await repo.loadByBattleVersion(fixture.battleId, 0)).toMatchObject({
      ok: true,
      value: { window: { status: "LOCKED", requiredControllers: [] }, submissions: [] },
    });
    const dispatcher = new AutoTurnDispatcher(
      new PostgresAutoTurnWindowReader(pool),
      service(pool),
    );
    const outcomes = await dispatcher.runOnce({ battleId: fixture.battleId, limit: 10 });
    const outcome = outcomes[0];
    if (outcome === undefined || !("result" in outcome)) throw new Error("Missing dispatch result");
    const resolved = outcome.result;
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const next = await repo.loadByBattleVersion(fixture.battleId, 1);
    expect(next).toMatchObject({
      ok: true,
      value: {
        window: {
          status: "COLLECTING",
          requiredControllers: [{ participantId: fixture.actorA, kind: "PLAYER" }],
        },
        submissions: [],
      },
    });
    const snapshot = await pool.query<{ state: BattleState }>(
      "SELECT state FROM battle_state_snapshots WHERE battle_id=$1 AND version=1",
      [fixture.battleId],
    );
    expect(snapshot.rows[0]?.state.sides[1]?.activeParticipantId).not.toBe(fixture.actorB);
    expect(snapshot.rows[0]?.state.combatants[0]?.currentHp).toBe(
      fixture.state.combatants[0]?.currentHp,
    );
    expect(await dispatcher.runOnce({ battleId: fixture.battleId, limit: 10 })).toEqual([]);
  });

  it("rolls back resolution when next-turn creation fails", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO");
    await pool.query(`CREATE OR REPLACE FUNCTION reject_test_next_window() RETURNS trigger AS $$
      BEGIN
        IF NEW.battle_id = '${fixture.battleId}'::uuid AND NEW.battle_version = 1 THEN
          RAISE EXCEPTION 'forced next-window failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER reject_test_next_window_trigger BEFORE INSERT ON battle_turn_windows
      FOR EACH ROW EXECUTE FUNCTION reject_test_next_window()`);
    const before = await resolutionCounts(pool, fixture);
    await expect(service(pool).resolve(fixture.windowId)).rejects.toThrow(
      "forced next-window failure",
    );
    expect(await resolutionCounts(pool, fixture)).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT id FROM battle_turn_windows WHERE battle_id=$1 AND battle_version=1",
          [fixture.battleId],
        )
      ).rowCount,
    ).toBe(0);
    await pool.query("DROP TRIGGER reject_test_next_window_trigger ON battle_turn_windows");
    await pool.query("DROP FUNCTION reject_test_next_window()");
    expect((await service(pool).resolve(fixture.windowId)).ok).toBe(true);
  });

  it("does not open a next window after a terminal PVE flee", async () => {
    const fixture = await seedLockedFixture(pool, "AUTO", false);
    const repo = new PostgresBattleTurnWindowRepository(pool);
    const opened = await repo.openForControllers({
      id: fixture.windowId,
      battleId: fixture.battleId,
      battleVersion: 0,
      turnNumber: 0,
      openedAt: new Date("2026-08-31T13:00:00.000Z"),
      deadlineAt: new Date("2026-08-31T13:05:00.000Z"),
    });
    expect(opened.ok).toBe(true);
    const submitted = await repo.submit(fixture.windowId, {
      id: randomUUID(),
      playerId: fixture.playerA,
      controllerRevision: 0,
      sideNo: 1,
      expectedBattleVersion: 0,
      idempotencyKey: randomUUID(),
      action: { type: "FLEE", actorParticipantId: fixture.actorA },
      submittedAt: new Date("2026-08-31T13:00:10.000Z"),
    });
    expect(submitted.ok).toBe(true);
    expect(await service(pool).resolve(fixture.windowId)).toMatchObject({
      ok: true,
      value: { state: { status: "FLED" } },
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM battle_turn_windows WHERE battle_id=$1 AND battle_version=1",
          [fixture.battleId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("atomically advances battle, snapshot, events and locked window without duplicating PVP battle_actions", async () => {
    const fixture = await seedLockedFixture(pool);
    const resolver = service(pool);

    const first = await resolver.resolve(fixture.windowId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.replayed).toBe(false);
    expect(first.value.state.version).toBe(1);
    expect(first.value.state.turnNumber).toBe(1);

    const persisted = await resolutionCounts(pool, fixture);
    expect(persisted.battle?.version).toBe("1");
    expect(persisted.battle?.turn_number).toBe(1);
    expect(persisted.snapshots).toBe("2");
    expect(Number(persisted.events)).toBeGreaterThan(0);
    expect(persisted.actions).toBe("0");
    expect(persisted.window?.status).toBe("COMMITTED");
    expect(persisted.window?.resolved_battle_version).toBe("1");
    expect(persisted.window?.resolution_correlation_id).not.toBeNull();
    expect(persisted.submissions).toEqual([{ status: "COMMITTED", count: "2" }]);

    const eventIdentity = await pool.query<{
      causation_count: string;
      correlation_count: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE causation_id = $2)::text AS causation_count,
         count(*) FILTER (WHERE correlation_id = $3)::text AS correlation_count
       FROM battle_events
       WHERE battle_id = $1`,
      [fixture.battleId, fixture.windowId, persisted.window?.resolution_correlation_id],
    );
    expect(eventIdentity.rows[0]?.causation_count).toBe(persisted.events);
    expect(eventIdentity.rows[0]?.correlation_count).toBe(persisted.events);

    const replay = await resolver.resolve(fixture.windowId);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.events).toEqual([]);
    expect(await resolutionCounts(pool, fixture)).toEqual(persisted);
  });

  it("persists a PVP surrender once, awards the opponent, and cancels the live window", async () => {
    const fixture = await seedLockedFixture(pool);
    const cancellation = new PostgresBattleCancellation(pool);

    const first = await cancellation.surrenderPvp({
      battleId: fixture.battleId,
      playerId: fixture.playerA,
      expectedVersion: 0,
    });
    expect(first).toMatchObject({ kind: "PERSISTED", state: { status: "LOST", version: 1 } });
    const replay = await cancellation.surrenderPvp({
      battleId: fixture.battleId,
      playerId: fixture.playerA,
      expectedVersion: 0,
    });
    expect(replay).toMatchObject({ kind: "REPLAYED", state: { status: "LOST", version: 1 } });

    expect(
      (await pool.query("SELECT status, ended_at FROM battles WHERE id=$1", [fixture.battleId]))
        .rows[0],
    ).toMatchObject({ status: "LOST" });
    expect(
      (await pool.query("SELECT status FROM battle_turn_windows WHERE id=$1", [fixture.windowId]))
        .rows[0],
    ).toEqual({ status: "CANCELLED" });
    expect(
      (
        await pool.query("SELECT result FROM battle_sides WHERE battle_id=$1 ORDER BY side_no", [
          fixture.battleId,
        ])
      ).rows,
    ).toEqual([{ result: "LOST" }, { result: "WON" }]);
    expect(
      await cancellation.surrenderPvp({
        battleId: fixture.battleId,
        playerId: fixture.playerB,
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: "NOT_ACTIVE" });
  });

  it("commits a terminal PVP KO without opening another turn window", async () => {
    const fixture = await seedLockedFixture(pool);
    const terminalState = structuredClone(fixture.state);
    const target = terminalState.combatants[1];
    if (target === undefined) throw new Error("Missing PVP target");
    target.currentHp = 1;
    await pool.query(
      "UPDATE battle_state_snapshots SET state=$2::jsonb WHERE battle_id=$1 AND version=0",
      [fixture.battleId, JSON.stringify(terminalState)],
    );

    const resolved = await service(pool).resolve(fixture.windowId);
    expect(resolved).toMatchObject({ ok: true, value: { state: { status: "WON", version: 1 } } });
    expect(
      (await pool.query("SELECT status, ended_at FROM battles WHERE id=$1", [fixture.battleId]))
        .rows[0],
    ).toMatchObject({ status: "WON" });
    expect(
      await pool.query(
        "SELECT id FROM battle_turn_windows WHERE battle_id=$1 AND battle_version=1",
        [fixture.battleId],
      ),
    ).toMatchObject({ rowCount: 0 });
  });

  it.each(["PVP", "AUTO", "NARRATOR", "ALL_AUTO"] as const)(
    "rolls back %s battle writes when the committed-window write fails",
    async (mode) => {
      const fixture = await seedLockedFixture(pool, mode);
      await pool.query(
        `CREATE OR REPLACE FUNCTION reject_test_window_commit() RETURNS trigger AS $$
       BEGIN
         IF NEW.id = '${fixture.windowId}'::uuid AND NEW.status = 'COMMITTED' THEN
           RAISE EXCEPTION 'forced turn-window commit failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        `CREATE TRIGGER reject_test_window_commit_trigger
       BEFORE UPDATE ON battle_turn_windows
       FOR EACH ROW EXECUTE FUNCTION reject_test_window_commit()`,
      );

      if (mode === "ALL_AUTO") {
        const dispatcher = new AutoTurnDispatcher(
          new PostgresAutoTurnWindowReader(pool),
          service(pool),
        );
        expect(await dispatcher.runOnce({ battleId: fixture.battleId, limit: 1 })).toEqual([
          {
            windowId: fixture.windowId,
            error: expect.objectContaining({ message: "forced turn-window commit failure" }),
          },
        ]);
      } else {
        await expect(service(pool).resolve(fixture.windowId)).rejects.toThrow(
          "forced turn-window commit failure",
        );
      }

      const persisted = await resolutionCounts(pool, fixture);
      expect(persisted.battle?.version).toBe("0");
      expect(persisted.battle?.turn_number).toBe(0);
      expect(persisted.snapshots).toBe("1");
      expect(persisted.events).toBe("0");
      expect(persisted.actions).toBe("0");
      expect(persisted.window?.status).toBe("LOCKED");
      expect(persisted.window?.resolved_battle_version).toBeNull();
      expect(persisted.window?.resolution_correlation_id).toBeNull();
      expect(persisted.submissions).toEqual(
        mode === "ALL_AUTO" ? [] : [{ status: "ACTIVE", count: mode === "AUTO" ? "1" : "2" }],
      );

      await pool.query("DROP TRIGGER reject_test_window_commit_trigger ON battle_turn_windows");
      await pool.query("DROP FUNCTION reject_test_window_commit()");
      if (mode === "ALL_AUTO") {
        const restarted = new AutoTurnDispatcher(
          new PostgresAutoTurnWindowReader(pool),
          service(pool),
        );
        expect(await restarted.runOnce({ battleId: fixture.battleId, limit: 1 })).toMatchObject([
          { windowId: fixture.windowId, result: { ok: true, value: { state: { version: 1 } } } },
        ]);
      }
    },
  );

  it.each(["AUTO", "NARRATOR", "ALL_AUTO"] as const)(
    "commits PVE %s once under concurrent resolvers and replays after restart",
    async (mode) => {
      const fixture = await seedLockedFixture(pool, mode);
      const results = await Promise.all([
        service(pool).resolve(fixture.windowId),
        service(pool).resolve(fixture.windowId),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
      const persisted = await resolutionCounts(pool, fixture);
      expect(persisted).toMatchObject({
        battle: { version: "1" },
        snapshots: "2",
        window: { status: "COMMITTED" },
        submissions:
          mode === "ALL_AUTO" ? [] : [{ status: "COMMITTED", count: mode === "AUTO" ? "1" : "2" }],
      });
      expect(Number(persisted.battle?.rng_counter)).toBeGreaterThan(0);
      const next = await new PostgresBattleTurnWindowRepository(pool).loadByBattleVersion(
        fixture.battleId,
        1,
      );
      expect(next).toMatchObject({
        ok: true,
        value: {
          window: {
            status: mode === "ALL_AUTO" ? "LOCKED" : "COLLECTING",
            battleVersion: 1,
          },
          submissions: [],
        },
      });
      if (!next.ok) throw new Error(next.error.message);
      expect(next.value.window.requiredControllers).toHaveLength(
        mode === "ALL_AUTO" ? 0 : mode === "AUTO" ? 1 : 2,
      );
      const restarted = service(pool);
      expect(await restarted.resolve(fixture.windowId)).toMatchObject({
        ok: true,
        value: { replayed: true },
      });
      expect(await resolutionCounts(pool, fixture)).toEqual(persisted);
    },
  );
});
