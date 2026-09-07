import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BattleState, MajorStatusKey } from "../../src/modules/battle/contracts.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { battleState } from "../battle/fixtures.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function stateWithPlayerPersistence(
  base: BattleState,
  input: {
    readonly version: number;
    readonly currentHp: number;
    readonly ppBySlot: Readonly<Record<number, number>>;
    readonly majorStatus: MajorStatusKey | null;
  },
): BattleState {
  return {
    ...base,
    turnNumber: input.version,
    version: input.version,
    rngCounter: String(input.version),
    combatants: base.combatants.map((combatant) => {
      if (combatant.participantKind !== "PLAYER_POKEMON") return combatant;
      return {
        ...combatant,
        currentHp: input.currentHp,
        majorStatus: input.majorStatus === null ? null : { key: input.majorStatus, counter: null },
        moves: combatant.moves.map((move) => ({
          ...move,
          ppCurrent: input.ppBySlot[move.slotNo] ?? move.ppCurrent,
        })),
      };
    }),
  };
}

async function seedFixture(pool: Pool): Promise<BattleState> {
  const state = battleState();
  const player = state.combatants.find((entry) => entry.participantKind === "PLAYER_POKEMON");
  const wild = state.combatants.find((entry) => entry.participantKind === "WILD_POKEMON");
  const playerSide = state.sides.find((entry) => entry.controllerKind === "PLAYER");
  const wildSide = state.sides.find((entry) => entry.controllerKind === "WILD");
  if (
    player === undefined ||
    player.pokemonInstanceId === null ||
    wild === undefined ||
    playerSide === undefined ||
    playerSide.playerId === null ||
    wildSide === undefined
  ) {
    throw new Error("Battle write-back fixture is incomplete");
  }

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [state.rulesetId, `writeback-ruleset-${state.rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 1, 'Battle write-back fixture', 'DRAFT', $2)`,
    [state.contentReleaseId, state.rulesetId],
  );
  await pool.query(`INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')`, [playerSide.playerId]);
  await pool.query(`INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 1, $2)`, [
    player.speciesId,
    `writeback-species-${player.speciesId}`,
  ]);
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')`, [
    player.formId,
    player.speciesId,
  ]);
  await pool.query(
    `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
     VALUES ($1, $2, $3, $4, $5, 'TEST')`,
    [player.pokemonInstanceId, playerSide.playerId, player.formId, player.level, player.currentHp],
  );

  for (const move of player.moves) {
    await pool.query(`INSERT INTO moves(id, slug) VALUES ($1, $2)`, [
      move.moveId,
      `writeback-move-${move.slotNo}-${move.moveId}`,
    ]);
    await pool.query(
      `INSERT INTO pokemon_move_slots(pokemon_instance_id, slot_no, move_id, pp_current)
       VALUES ($1, $2, $3, $4)`,
      [player.pokemonInstanceId, move.slotNo, move.moveId, move.ppCurrent],
    );
  }
  await pool.query(
    `INSERT INTO pokemon_persistent_conditions(
       pokemon_instance_id, condition_key, source_type, source_id
     ) VALUES ($1, 'BURN', 'TEST', 'seed')`,
    [player.pokemonInstanceId],
  );

  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv,
       rng_seed_auth_tag, rng_seed_key_version, rng_counter
     ) VALUES ($1, 'WILD', 'ACTIVE', $2, $3, 0, 0, $4, $5, $6, 1, 0)`,
    [
      state.battleId,
      state.contentReleaseId,
      state.rulesetId,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(16, 3),
    ],
  );
  const playerSideId = randomUUID();
  const wildSideId = randomUUID();
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $3, $4, 'PLAYER', $6), ($2, $3, $5, 'WILD', NULL)`,
    [
      playerSideId,
      wildSideId,
      state.battleId,
      playerSide.sideNo,
      wildSide.sideNo,
      playerSide.playerId,
    ],
  );
  await pool.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, active_member, snapshot
     ) VALUES
       ($1, $5, $3, $6, 'PLAYER_POKEMON', $8, TRUE, $10::jsonb),
       ($2, $5, $4, NULL, 'WILD_POKEMON', $9, TRUE, $11::jsonb)`,
    [
      player.participantId,
      wild.participantId,
      playerSideId,
      wildSideId,
      state.battleId,
      player.pokemonInstanceId,
      null,
      player.rosterPosition,
      wild.rosterPosition,
      JSON.stringify(player),
      JSON.stringify(wild),
    ],
  );
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 0, 1, $2::jsonb)`,
    [state.battleId, JSON.stringify(state)],
  );
  return state;
}

async function persistedPlayerState(pool: Pool, state: BattleState) {
  const player = state.combatants.find((entry) => entry.participantKind === "PLAYER_POKEMON");
  if (player === undefined || player.pokemonInstanceId === null) {
    throw new Error("Player Pokemon is missing from test state");
  }
  const [pokemon, moves, conditions] = await Promise.all([
    pool.query<{ current_hp: number; revision: string }>(
      `SELECT current_hp, revision::text FROM pokemon_instances WHERE id = $1`,
      [player.pokemonInstanceId],
    ),
    pool.query<{ slot_no: number; pp_current: number | null }>(
      `SELECT slot_no, pp_current FROM pokemon_move_slots
       WHERE pokemon_instance_id = $1 ORDER BY slot_no`,
      [player.pokemonInstanceId],
    ),
    pool.query<{
      condition_key: string;
      source_type: string;
      source_id: string;
      data: unknown;
    }>(
      `SELECT condition_key, source_type, source_id, data
       FROM pokemon_persistent_conditions
       WHERE pokemon_instance_id = $1 ORDER BY condition_key`,
      [player.pokemonInstanceId],
    ),
  ]);
  return { pokemon: pokemon.rows[0], moves: moves.rows, conditions: conditions.rows };
}

async function persistTurn(pool: Pool, previous: BattleState, next: BattleState, suffix: string) {
  const player = previous.combatants.find((entry) => entry.participantKind === "PLAYER_POKEMON");
  const wild = previous.combatants.find((entry) => entry.participantKind === "WILD_POKEMON");
  if (player === undefined || wild === undefined) {
    throw new Error("Test battle combatants are missing");
  }
  const repository = new PostgresBattleRepository(pool);
  return repository.transaction((transaction) =>
    transaction.persistTurn({
      actionId: randomUUID(),
      battleId: previous.battleId,
      expectedVersion: previous.version,
      idempotencyKey: `battle-writeback-${suffix}-${previous.battleId}`,
      correlationId: randomUUID(),
      playerAction: {
        type: "USE_MOVE",
        actorParticipantId: player.participantId,
        targetParticipantId: wild.participantId,
        moveSlot: 1,
      },
      nextState: next,
      events: [],
      rngCounter: BigInt(next.rngCounter),
    }),
  );
}

describe("Battle player state PostgreSQL write-back", () => {
  const dbName = `pokemon_battle_writeback_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "battle-player-writeback-vitest" });
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

  it("writes HP, PP and major status from each committed battle turn back to the owned Pokemon", async () => {
    const initial = await seedFixture(pool);
    const poisoned = stateWithPlayerPersistence(initial, {
      version: 1,
      currentHp: 11,
      ppBySlot: { 1: 34 },
      majorStatus: "POISON",
    });

    const first = await persistTurn(pool, initial, poisoned, "poisoned");
    expect(first.kind).toBe("PERSISTED");
    expect(await persistedPlayerState(pool, poisoned)).toEqual({
      pokemon: { current_hp: 11, revision: "1" },
      moves: [
        { slot_no: 1, pp_current: 34 },
        { slot_no: 2, pp_current: 25 },
        { slot_no: 3, pp_current: 30 },
        { slot_no: 4, pp_current: 40 },
      ],
      conditions: [
        {
          condition_key: "POISON",
          source_type: "BATTLE",
          source_id: initial.battleId,
          data: { counter: null },
        },
      ],
    });

    const cleared = stateWithPlayerPersistence(poisoned, {
      version: 2,
      currentHp: 7,
      ppBySlot: { 2: 24 },
      majorStatus: null,
    });
    const second = await persistTurn(pool, poisoned, cleared, "cleared");
    expect(second.kind).toBe("PERSISTED");
    expect(await persistedPlayerState(pool, cleared)).toEqual({
      pokemon: { current_hp: 7, revision: "2" },
      moves: [
        { slot_no: 1, pp_current: 34 },
        { slot_no: 2, pp_current: 24 },
        { slot_no: 3, pp_current: 30 },
        { slot_no: 4, pp_current: 40 },
      ],
      conditions: [],
    });
  });
});
