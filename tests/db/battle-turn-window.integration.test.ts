import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BattleAction } from "../../src/modules/battle/contracts.js";
import type {
  CreateTurnWindowInput,
  SubmitTurnActionInput,
} from "../../src/modules/battle/turn-window.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

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

interface Fixture {
  readonly battleId: string;
  readonly playerA: string;
  readonly playerB: string;
  readonly actorA: string;
  readonly actorB: string;
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const playerA = randomUUID();
  const playerB = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const pokemonA = randomUUID();
  const pokemonB = randomUUID();
  const battleId = randomUUID();
  const sideA = randomUUID();
  const sideB = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `turn-window-${rulesetId}`],
  );
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 27001, 'TurnWindow integration', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE'), ($2, 'ACTIVE')", [
    playerA,
    playerB,
  ]);
  await client.query("INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 9999, $2)", [
    speciesId,
    `turn-window-species-${speciesId}`,
  ]);
  await client.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await client.query(
    `INSERT INTO pokemon_instances(id, owner_player_id, form_id, level, current_hp, origin_type)
     VALUES ($1, $2, $5, 5, 20, 'TEST'), ($3, $4, $5, 5, 20, 'TEST')`,
    [pokemonA, playerA, pokemonB, playerB, formId],
  );
  await client.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv,
       rng_seed_auth_tag, rng_seed_key_version, rng_counter
     ) VALUES ($1, 'PVP', 'ACTIVE', $2, $3, 4, 7, $4, $5, $6, 1, 0)`,
    [battleId, releaseId, rulesetId, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(16, 3)],
  );
  await client.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $3, 1, 'PLAYER', $4), ($2, $3, 2, 'PLAYER', $5)`,
    [sideA, sideB, battleId, playerA, playerB],
  );
  await client.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, active_member, snapshot
     ) VALUES
       ($1, $5, $3, $6, 'PLAYER_POKEMON', 1, TRUE, '{}'::jsonb),
       ($2, $5, $4, $7, 'PLAYER_POKEMON', 1, TRUE, '{}'::jsonb)`,
    [actorA, actorB, sideA, sideB, battleId, pokemonA, pokemonB],
  );
  await client.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, 7, 1, '{}'::jsonb)`,
    [battleId],
  );

  return { battleId, playerA, playerB, actorA, actorB };
}

async function cloneBattleFixture(pool: Pool, source: Fixture, version: number): Promise<Fixture> {
  const battleId = randomUUID();
  const sideA = randomUUID();
  const sideB = randomUUID();
  const actorA = randomUUID();
  const actorB = randomUUID();

  await pool.query(
    `INSERT INTO battles(
       id, battle_type, status, content_release_id, ruleset_id,
       turn_number, version, rng_seed_ciphertext, rng_seed_iv,
       rng_seed_auth_tag, rng_seed_key_version, rng_counter
     )
     SELECT $1, 'PVP', 'ACTIVE', content_release_id, ruleset_id,
            4, $2, $3, $4, $5, 1, 0
     FROM battles WHERE id = $6`,
    [
      battleId,
      version,
      Buffer.alloc(32, version),
      Buffer.alloc(12, version),
      Buffer.alloc(16, version),
      source.battleId,
    ],
  );
  await pool.query(
    `INSERT INTO battle_sides(id, battle_id, side_no, controller_kind, player_id)
     VALUES ($1, $3, 1, 'PLAYER', $4), ($2, $3, 2, 'PLAYER', $5)`,
    [sideA, sideB, battleId, source.playerA, source.playerB],
  );
  await pool.query(
    `INSERT INTO battle_participants(
       id, battle_id, battle_side_id, pokemon_instance_id, participant_kind,
       roster_position, active_member, snapshot
     )
     SELECT $1, $5, $3, pokemon_instance_id, 'PLAYER_POKEMON', 1, TRUE, '{}'::jsonb
     FROM battle_participants WHERE id = $6
     UNION ALL
     SELECT $2, $5, $4, pokemon_instance_id, 'PLAYER_POKEMON', 1, TRUE, '{}'::jsonb
     FROM battle_participants WHERE id = $7`,
    [actorA, actorB, sideA, sideB, battleId, source.actorA, source.actorB],
  );
  await pool.query(
    `INSERT INTO battle_state_snapshots(battle_id, version, schema_version, state)
     VALUES ($1, $2, 1, '{}'::jsonb)`,
    [battleId, version],
  );

  return {
    battleId,
    playerA: source.playerA,
    playerB: source.playerB,
    actorA,
    actorB,
  };
}

function moveAction(
  actorParticipantId: string,
  targetParticipantId: string,
  moveSlot: number,
): BattleAction {
  return {
    type: "USE_MOVE",
    actorParticipantId,
    targetParticipantId,
    moveSlot,
  };
}

function windowInput(
  fixture: Fixture,
  battleVersion = 7,
  id = randomUUID(),
): CreateTurnWindowInput {
  return {
    id,
    battleId: fixture.battleId,
    battleVersion,
    turnNumber: 4,
    openedAt: new Date("2026-08-31T12:00:00.000Z"),
    deadlineAt: new Date("2026-08-31T12:05:00.000Z"),
    requiredPlayers: [
      { playerId: fixture.playerA, sideNo: 1 },
      { playerId: fixture.playerB, sideNo: 2 },
    ],
  };
}

function submission(
  fixture: Fixture,
  player: "A" | "B",
  idempotencyKey: string,
  moveSlot: number,
  submittedAt: Date,
  expectedBattleVersion = 7,
): SubmitTurnActionInput {
  const isA = player === "A";
  return {
    id: randomUUID(),
    playerId: isA ? fixture.playerA : fixture.playerB,
    sideNo: isA ? 1 : 2,
    expectedBattleVersion,
    idempotencyKey,
    action: moveAction(
      isA ? fixture.actorA : fixture.actorB,
      isA ? fixture.actorB : fixture.actorA,
      moveSlot,
    ),
    submittedAt,
  };
}

describe("battle TurnWindow PostgreSQL integration", () => {
  const dbName = `pokemon_turn_window_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 16 });
    await runMigrations(pool, { appliedBy: "flow003-turn-window-vitest" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
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

  it("opens exactly one persisted window for a battle version under concurrent retries", async () => {
    const repository = new PostgresBattleTurnWindowRepository(pool);
    const [first, second] = await Promise.all([
      repository.open(windowInput(fixture)),
      repository.open(windowInput(fixture)),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.aggregate.window.id).toBe(second.value.aggregate.window.id);
    expect([first.value.replayed, second.value.replayed].sort()).toEqual([false, true]);

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battle_turn_windows WHERE battle_id = $1 AND battle_version = 7",
      [fixture.battleId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("serializes two human submissions and persists a single LOCKED final state", async () => {
    const repository = new PostgresBattleTurnWindowRepository(pool);
    const opened = await repository.loadByBattleVersion(fixture.battleId, 7);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const [a, b] = await Promise.all([
      repository.submit(
        opened.value.window.id,
        submission(fixture, "A", "concurrent-a", 1, new Date("2026-08-31T12:00:10.000Z")),
      ),
      repository.submit(
        opened.value.window.id,
        submission(fixture, "B", "concurrent-b", 2, new Date("2026-08-31T12:00:11.000Z")),
      ),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const restartedRepository = new PostgresBattleTurnWindowRepository(pool);
    const persisted = await restartedRepository.loadByBattleVersion(fixture.battleId, 7);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value.window.status).toBe("LOCKED");
    expect(persisted.value.window.deadlineAt).toBe("2026-08-31T12:05:00.000Z");
    expect(persisted.value.submissions.filter((entry) => entry.status === "ACTIVE")).toHaveLength(
      2,
    );
  });

  it("serializes concurrent replacements so one action remains ACTIVE and revisions stay auditable", async () => {
    const replacementFixture = await cloneBattleFixture(pool, fixture, 8);
    const repository = new PostgresBattleTurnWindowRepository(pool);
    const opened = await repository.open(windowInput(replacementFixture, 8));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const first = await repository.submit(
      opened.value.aggregate.window.id,
      submission(replacementFixture, "A", "replace-v1", 1, new Date("2026-08-31T12:00:10.000Z"), 8),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const [second, third] = await Promise.all([
      repository.submit(
        opened.value.aggregate.window.id,
        submission(
          replacementFixture,
          "A",
          "replace-v2",
          2,
          new Date("2026-08-31T12:00:20.000Z"),
          8,
        ),
      ),
      repository.submit(
        opened.value.aggregate.window.id,
        submission(
          replacementFixture,
          "A",
          "replace-v3",
          3,
          new Date("2026-08-31T12:00:21.000Z"),
          8,
        ),
      ),
    ]);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);

    const persisted = await repository.loadByBattleVersion(replacementFixture.battleId, 8);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    const mine = persisted.value.submissions.filter(
      (entry) => entry.playerId === replacementFixture.playerA,
    );
    expect(mine).toHaveLength(3);
    expect(mine.map((entry) => entry.submissionRevision).sort()).toEqual([1, 2, 3]);
    expect(mine.filter((entry) => entry.status === "ACTIVE")).toHaveLength(1);
    expect(mine.filter((entry) => entry.status === "SUPERSEDED")).toHaveLength(2);
    expect(persisted.value.window.status).toBe("COLLECTING");
  });
});
