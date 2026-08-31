import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BattleAction,
  BattleCombatant,
  BattleState,
} from "../../src/modules/battle/contracts.js";
import { PvpTurnResolutionService } from "../../src/modules/battle/pvp-turn-resolution.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { PostgresPvpTurnResolutionRepository } from "../../src/platform/battle/postgres-pvp-turn-resolution-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
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

async function seedLockedFixture(pool: Pool): Promise<Fixture> {
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
  const state = stateFor({
    battleId,
    rulesetId,
    releaseId,
    playerA,
    playerB,
    actorA,
    actorB,
  });
  const pokemonA = state.combatants[0]?.pokemonInstanceId;
  const pokemonB = state.combatants[1]?.pokemonInstanceId;
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
  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv,
       rng_seed_auth_tag, rng_seed_key_version, rng_counter
     ) VALUES ($1, 'PVP', 'ACTIVE', $2, $3, 0, 0, $4, $5, $6, 1, 0)`,
    [battleId, releaseId, rulesetId, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(16, 3)],
  );
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
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 0, 1, $2::jsonb)`,
    [battleId, JSON.stringify(state)],
  );

  const turnWindows = new PostgresBattleTurnWindowRepository(pool);
  const opened = await turnWindows.open({
    id: windowId,
    battleId,
    battleVersion: 0,
    turnNumber: 0,
    openedAt: new Date("2026-08-31T13:00:00.000Z"),
    deadlineAt: new Date("2026-08-31T13:05:00.000Z"),
    requiredPlayers: [
      { playerId: playerA, sideNo: 1 },
      { playerId: playerB, sideNo: 2 },
    ],
  });
  if (!opened.ok) throw new Error(opened.error.message);

  const submittedA = await turnWindows.submit(windowId, {
    id: randomUUID(),
    playerId: playerA,
    sideNo: 1,
    expectedBattleVersion: 0,
    idempotencyKey: `pvp-resolution-a-${battleId}`,
    action: action(actorA, actorB),
    submittedAt: new Date("2026-08-31T13:00:10.000Z"),
  });
  if (!submittedA.ok) throw new Error(submittedA.error.message);
  const submittedB = await turnWindows.submit(windowId, {
    id: randomUUID(),
    playerId: playerB,
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
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("atomically advances battle, snapshot, events and locked window without duplicating PVP battle_actions", async () => {
    const fixture = await seedLockedFixture(pool);
    const resolver = service(pool);

    const first = await resolver.resolve(fixture.windowId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.replayed).toBe(false);
    expect(first.value.state.status).toBe("ACTIVE");
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

    const nextWindow = await pool.query<{
      id: string;
      battle_version: string;
      turn_number: number;
      status: string;
      opened_at: Date;
      deadline_at: Date;
    }>(
      `SELECT id, battle_version::text, turn_number, status, opened_at, deadline_at
       FROM battle_turn_windows
       WHERE battle_id = $1 AND battle_version = 1`,
      [fixture.battleId],
    );
    expect(nextWindow.rows).toHaveLength(1);
    expect(nextWindow.rows[0]?.status).toBe("COLLECTING");
    expect(nextWindow.rows[0]?.turn_number).toBe(1);
    expect(nextWindow.rows[0]?.opened_at.toISOString()).toBe("2026-08-31T13:01:00.000Z");
    expect(nextWindow.rows[0]?.deadline_at.toISOString()).toBe("2026-08-31T13:06:00.000Z");

    const nextRequiredPlayers = await pool.query<{ player_id: string; side_no: number }>(
      `SELECT player_id, side_no
       FROM battle_turn_window_required_players
       WHERE turn_window_id = $1
       ORDER BY side_no`,
      [nextWindow.rows[0]?.id],
    );
    expect(nextRequiredPlayers.rows).toEqual([
      { player_id: fixture.playerA, side_no: 1 },
      { player_id: fixture.playerB, side_no: 2 },
    ]);

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
    const windowCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM battle_turn_windows WHERE battle_id = $1`,
      [fixture.battleId],
    );
    expect(windowCount.rows[0]?.count).toBe("2");
  });

  it("rolls back battle writes when the committed-window write fails", async () => {
    const fixture = await seedLockedFixture(pool);
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

    await expect(service(pool).resolve(fixture.windowId)).rejects.toThrow(
      "forced turn-window commit failure",
    );

    const persisted = await resolutionCounts(pool, fixture);
    expect(persisted.battle?.version).toBe("0");
    expect(persisted.battle?.turn_number).toBe(0);
    expect(persisted.snapshots).toBe("1");
    expect(persisted.events).toBe("0");
    expect(persisted.actions).toBe("0");
    expect(persisted.window?.status).toBe("LOCKED");
    expect(persisted.window?.resolved_battle_version).toBeNull();
    expect(persisted.window?.resolution_correlation_id).toBeNull();
    expect(persisted.submissions).toEqual([{ status: "ACTIVE", count: "2" }]);

    await pool.query("DROP TRIGGER reject_test_window_commit_trigger ON battle_turn_windows");
    await pool.query("DROP FUNCTION reject_test_window_commit()");
  });
});
