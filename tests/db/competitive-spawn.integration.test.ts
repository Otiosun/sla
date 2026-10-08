import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompetitiveSpawnRenderSpec } from "../../src/modules/competitive-spawn/contracts.js";
import type { WildPokemonSnapshot } from "../../src/modules/encounter/contracts.js";
import { PostgresCompetitiveSpawnRepository } from "../../src/platform/competitive-spawn/postgres-competitive-spawn-repository.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("competitive spawn repository on disposable PostgreSQL", () => {
  const dbName = `pokemon_comp_spawn_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresCompetitiveSpawnRepository;

  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const moveId = randomUUID();
  const groupId = randomUUID();
  const playerA = randomUUID();
  const playerB = randomUUID();
  const playerBox = randomUUID();
  const inboxA = randomUUID();
  const inboxB = randomUUID();
  const inboxBox = randomUUID();

  const snapshot: WildPokemonSnapshot = {
    schemaVersion: 1,
    formId,
    speciesId,
    level: 12,
    type1Id: typeId,
    type2Id: null,
    baseStats: {
      hp: 35,
      attack: 55,
      defense: 40,
      spAttack: 50,
      spDefense: 50,
      speed: 90,
    },
    ivs: {
      hp: 12,
      attack: 13,
      defense: 14,
      spAttack: 15,
      spDefense: 16,
      speed: 17,
    },
    natureId,
    abilityId,
    moves: [{ moveId, ppCurrent: 35 }],
    maxHp: 35,
    currentHp: 35,
    shiny: false,
    gender: "MALE",
  };

  const renderSpec: CompetitiveSpawnRenderSpec = {
    schemaVersion: 1,
    backgroundUrl: "https://assets.test/background.png",
    spriteUrl: "https://assets.test/25.png",
    fallbackSpriteUrl: "https://assets.test/25-fallback.png",
    centerX: 500,
    groundY: 438,
    maxSize: 320,
    floatY: 0,
    shadowOpacity: 0.25,
    timeBucket: "DAY",
  };

  async function insertPlayer(playerId: string, trainerName: string): Promise<void> {
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
       VALUES ($1, 'COMPLETE', $2, now())`,
      [playerId, `competitive-spawn-test:${playerId}`],
    );
    await pool.query(
      `INSERT INTO player_profiles(player_id, trainer_name)
       VALUES ($1, $2)`,
      [playerId, trainerName],
    );
  }

  async function insertInbox(inboxId: string, playerId: string, suffix: string): Promise<void> {
    await pool.query(
      `INSERT INTO inbox_messages(
         id, provider, external_message_id, player_id, payload_hash, status, correlation_id
       ) VALUES ($1, 'baileys', $2, $3, 'sha256:test', 'PROCESSING', $4)`,
      [inboxId, `wamid-${suffix}`, playerId, randomUUID()],
    );
  }

  function spawnWrite(spawnId: string, openedAt: Date, expiresAt: Date) {
    return {
      id: spawnId,
      communityGroupId: groupId,
      provider: "baileys",
      chatRef: "120363000000000000@g.us",
      contentReleaseId: releaseId,
      rulesetId,
      areaId: null,
      formId,
      speciesId,
      speciesDisplayName: "Pikachu",
      normalizedAnswers: ["pikachu"],
      nationalDex: 25,
      level: snapshot.level,
      shiny: snapshot.shiny,
      snapshot,
      renderSpec,
      creationIdempotencyKey: `spawn:${spawnId}`,
      openedAt,
      expiresAt,
    } as const;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 12 });
    await runMigrations(pool, { appliedBy: "competitive-spawn-vitest" });
    repository = new PostgresCompetitiveSpawnRepository(pool);

    await pool.query(
      `INSERT INTO rulesets(
         id, key, version, engine_contract_version, config, status
       ) VALUES ($1, 'competitive-spawn-test', 1, 1, '{}'::jsonb, 'DRAFT')`,
      [rulesetId],
    );
    await pool.query(
      `INSERT INTO content_releases(
         id, release_no, name, status, default_ruleset_id
       ) VALUES ($1, 1, 'Competitive Spawn Test', 'DRAFT', $2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO pokemon_types(id, slug) VALUES ($1, 'electric-test')", [typeId]);
    await pool.query("INSERT INTO abilities(id, slug) VALUES ($1, 'static-test')", [abilityId]);
    await pool.query("INSERT INTO natures(id, slug) VALUES ($1, 'hardy-test')", [natureId]);
    await pool.query("INSERT INTO moves(id, slug) VALUES ($1, 'tackle-test')", [moveId]);
    await pool.query(
      "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 25, 'pikachu')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'pikachu')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO community_groups(
         id, provider, chat_ref, role, display_name, status
       ) VALUES ($1, 'baileys', '120363000000000000@g.us', 'GAME', 'V65 Test', 'ACTIVE')`,
      [groupId],
    );

    await insertPlayer(playerA, "Alpha");
    await insertPlayer(playerB, "Beta");
    await insertPlayer(playerBox, "Boxer");
    await insertInbox(inboxA, playerA, "alpha");
    await insertInbox(inboxB, playerB, "beta");
    await insertInbox(inboxBox, playerBox, "box");
  }, 30_000);

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
    if (adminPool !== undefined) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.end();
    }
  }, 30_000);

  it("allows exactly one winner and one Pokemon grant under concurrent correct claims", async () => {
    const spawnId = randomUUID();
    const openedAt = new Date();
    const created = await repository.createOpen(
      spawnWrite(spawnId, openedAt, new Date(openedAt.getTime() + 60_000)),
      0,
    );
    expect(created?.id).toBe(spawnId);

    const first = repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxA,
      playerId: playerA,
      senderRef: "5511000000001@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-alpha",
      now: new Date(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxB,
      playerId: playerB,
      senderRef: "5511000000002@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-beta",
      now: new Date(),
    });

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.kind === "WON")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "CLOSED")).toHaveLength(1);

    const persisted = await pool.query<{
      grants: string;
      pokemon: string;
      correct_attempts: string;
      won_spawns: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM competitive_spawn_grants WHERE spawn_id = $1) AS grants,
         (SELECT count(*)::text FROM pokemon_instances WHERE origin_type = 'COMPETITIVE_SPAWN' AND origin_id = $1) AS pokemon,
         (SELECT count(*)::text FROM competitive_spawn_attempts WHERE spawn_id = $1 AND correct) AS correct_attempts,
         (SELECT count(*)::text FROM competitive_spawns WHERE id = $1 AND status = 'WON') AS won_spawns`,
      [spawnId],
    );
    expect(persisted.rows[0]).toEqual({
      grants: "1",
      pokemon: "1",
      correct_attempts: "1",
      won_spawns: "1",
    });

    const winner = results.find((result) => result.kind === "WON");
    if (winner?.kind !== "WON") throw new Error("winner was not resolved");
    const replay = await repository.claimCorrect({
      spawnId,
      inboxMessageId: winner.spawn.winnerPlayerId === playerA ? inboxA : inboxB,
      playerId: winner.spawn.winnerPlayerId ?? playerA,
      senderRef: "5511000000009@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-replay",
      now: new Date(),
    });
    expect(replay.kind).toBe("CLOSED");

    const grantCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM competitive_spawn_grants WHERE spawn_id = $1",
      [spawnId],
    );
    expect(grantCount.rows[0]?.count).toBe("1");
  });

  it("places a competitive winner into Box 1 slot 1 when the team is full", async () => {
    for (let slot = 1; slot <= 6; slot += 1) {
      const pokemonId = randomUUID();
      await pool.query(
        `INSERT INTO pokemon_instances(
           id, owner_player_id, form_id, level, current_hp, origin_type
         ) VALUES ($1, $2, $3, 5, 20, 'TEST')`,
        [pokemonId, playerBox, formId],
      );
      await pool.query(
        `INSERT INTO pokemon_roster_slots(
           pokemon_instance_id, player_id, placement_kind, slot_no
         ) VALUES ($1, $2, 'TEAM', $3)`,
        [pokemonId, playerBox, slot],
      );
    }

    const spawnId = randomUUID();
    const openedAt = new Date();
    await repository.createOpen(
      spawnWrite(spawnId, openedAt, new Date(openedAt.getTime() + 60_000)),
      0,
    );

    const result = await repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxBox,
      playerId: playerBox,
      senderRef: "5511000000003@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-box",
      now: new Date(),
    });

    expect(result.kind).toBe("WON");
    if (result.kind !== "WON") return;
    expect(result.placement).toEqual({
      placementKind: "BOX",
      boxNo: 1,
      slotNo: 1,
    });
  });

  it("expires a stale OPEN row atomically before opening the next spawn", async () => {
    const staleId = randomUUID();
    const staleOpened = new Date();
    await repository.createOpen(
      spawnWrite(staleId, staleOpened, new Date(staleOpened.getTime() + 80)),
      0,
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const freshId = randomUUID();
    const freshOpened = new Date();
    const fresh = await repository.createOpen(
      spawnWrite(freshId, freshOpened, new Date(freshOpened.getTime() + 60_000)),
      0,
    );
    expect(fresh?.id).toBe(freshId);

    const statuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM competitive_spawns WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[staleId, freshId]],
    );
    expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [staleId, "EXPIRED"],
        [freshId, "OPEN"],
      ]),
    );
  });
});
