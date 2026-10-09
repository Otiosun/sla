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

  function spawnWrite(
    spawnId: string,
    openedAt: Date,
    expiresAt: Date,
    communityGroupId: string = groupId,
  ) {
    return {
      id: spawnId,
      communityGroupId,
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

  async function imageOutbox(
    spawnId: string,
    status: "SENT" | "DEAD",
    sentAt: Date | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key,
         status, attempts, next_attempt_at, correlation_id, causation_id, sequence_no, sent_at
       ) VALUES (
         $1, 'whatsapp', '120363000000000000@g.us', 'IMAGE', $2::jsonb, $3,
         $4, 1, NULL, $5, NULL, 0, $6
       )`,
      [
        randomUUID(),
        JSON.stringify({ caption: "✨ Um Pokémon selvagem apareceu!" }),
        `competitive-spawn:${spawnId}:image`,
        status,
        randomUUID(),
        sentAt,
      ],
    );
  }

  async function publishSpawn(spawnId: string, sentAt = new Date()): Promise<Date> {
    await imageOutbox(spawnId, "SENT", sentAt);
    const reconciled = await repository.reconcilePublication({
      now: sentAt,
      ttlMs: 5 * 60_000,
      orphanGraceMs: 2 * 60_000,
      limit: 100,
    });
    expect(reconciled).toEqual({ published: 1, cancelled: 0 });
    return sentAt;
  }

  async function failUnpublishedSpawn(spawnId: string, now = new Date()): Promise<void> {
    await imageOutbox(spawnId, "DEAD", null);
    const reconciled = await repository.reconcilePublication({
      now,
      ttlMs: 5 * 60_000,
      orphanGraceMs: 2 * 60_000,
      limit: 100,
    });
    expect(reconciled.cancelled).toBe(1);
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
    await publishSpawn(spawnId);

    const first = repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxA,
      playerId: playerA,
      senderRef: "5511000000001@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-alpha",
      correlationId: "00000000-0000-4000-8000-000000000065",
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 0,
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
      correlationId: "00000000-0000-4000-8000-000000000065",
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 0,
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
      correlationId: "00000000-0000-4000-8000-000000000065",
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 0,
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
    await publishSpawn(spawnId);

    const result = await repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxBox,
      playerId: playerBox,
      senderRef: "5511000000003@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-box",
      correlationId: "00000000-0000-4000-8000-000000000065",
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 0,
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

  it("records seen and durable reward even when the Pokemon bonus does not roll", async () => {
    const inboxId = randomUUID();
    await insertInbox(inboxId, playerA, "no-bonus");

    const before = await pool.query<{ seen_count: number; caught_count: number }>(
      `SELECT seen_count, caught_count
       FROM player_pokedex_species
       WHERE player_id = $1 AND species_id = $2`,
      [playerA, speciesId],
    );
    const beforeSeen = Number(before.rows[0]?.seen_count ?? 0);
    const beforeCaught = Number(before.rows[0]?.caught_count ?? 0);

    const spawnId = randomUUID();
    const openedAt = new Date();
    await repository.createOpen(
      spawnWrite(spawnId, openedAt, new Date(openedAt.getTime() + 60_000)),
      0,
    );
    await publishSpawn(spawnId);

    const result = await repository.claimCorrect({
      spawnId,
      inboxMessageId: inboxId,
      playerId: playerA,
      senderRef: "5511000000099@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-no-bonus",
      correlationId: randomUUID(),
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 9999,
      now: new Date(),
    });

    expect(result.kind).toBe("WON");
    if (result.kind !== "WON") return;
    expect(result.pokemonBonus).toBe(false);
    expect(result.pokemonInstanceId).toBeNull();
    expect(result.placement).toBeNull();

    const after = await pool.query<{
      seen_count: number;
      caught_count: number;
      reward_intents: string;
      pokemon_grants: string;
    }>(
      `SELECT
         COALESCE((SELECT seen_count FROM player_pokedex_species WHERE player_id = $2 AND species_id = $3), 0) AS seen_count,
         COALESCE((SELECT caught_count FROM player_pokedex_species WHERE player_id = $2 AND species_id = $3), 0) AS caught_count,
         (SELECT count(*)::text FROM competitive_spawn_reward_intents WHERE spawn_id = $1) AS reward_intents,
         (SELECT count(*)::text FROM competitive_spawn_grants WHERE spawn_id = $1) AS pokemon_grants`,
      [spawnId, playerA, speciesId],
    );
    expect(Number(after.rows[0]?.seen_count ?? 0)).toBe(beforeSeen + 1);
    expect(Number(after.rows[0]?.caught_count ?? 0)).toBe(beforeCaught);
    expect(after.rows[0]?.reward_intents).toBe("1");
    expect(after.rows[0]?.pokemon_grants).toBe("0");
  });

  it("reserves unpublished OPEN, cancels DEAD without cooldown, and anchors TTL to SENT", async () => {
    const lifecycleGroupId = randomUUID();
    await pool.query(
      `INSERT INTO community_groups(
         id, provider, chat_ref, role, display_name, status
       ) VALUES ($1, 'baileys', $2, 'GAME', 'V65 Lifecycle Test', 'ACTIVE')`,
      [lifecycleGroupId, `120363-lifecycle-${lifecycleGroupId}@g.us`],
    );

    await pool.query(
      `INSERT INTO competitive_spawn_activity_state(
         community_group_id, progress_milli, target_roll, cycle_no,
         last_activity_at, last_player_id, sender_streak, updated_at
       ) VALUES ($1, 4321, 1000, 7, now(), $2, 2, now())
       ON CONFLICT (community_group_id) DO UPDATE SET
         progress_milli = 4321,
         target_roll = 1000,
         cycle_no = 7,
         last_activity_at = now(),
         last_player_id = $2,
         sender_streak = 2,
         updated_at = now()`,
      [lifecycleGroupId, playerA],
    );

    const pendingId = randomUUID();
    const pendingOpened = new Date();
    const pending = await repository.createOpen(
      spawnWrite(
        pendingId,
        pendingOpened,
        new Date(pendingOpened.getTime() + 80),
        lifecycleGroupId,
      ),
      60_000,
    );
    expect(pending?.id).toBe(pendingId);
    await expect(repository.activeForGroup(lifecycleGroupId)).resolves.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 120));

    const blockedId = randomUUID();
    const blocked = await repository.createOpen(
      spawnWrite(blockedId, new Date(), new Date(Date.now() + 60_000), lifecycleGroupId),
      60_000,
    );
    expect(blocked).toBeNull();

    await failUnpublishedSpawn(pendingId, new Date());

    const preserved = await pool.query<{
      progress_milli: number;
      target_roll: number | null;
      cycle_no: string;
    }>(
      `SELECT progress_milli, target_roll, cycle_no::text
       FROM competitive_spawn_activity_state
       WHERE community_group_id = $1`,
      [lifecycleGroupId],
    );
    expect(preserved.rows[0]).toEqual({
      progress_milli: 4321,
      target_roll: 1000,
      cycle_no: "7",
    });
    await expect(repository.canOpen(lifecycleGroupId, new Date(), 60_000)).resolves.toBe(true);

    const freshId = randomUUID();
    const freshOpened = new Date();
    const fresh = await repository.createOpen(
      spawnWrite(freshId, freshOpened, new Date(freshOpened.getTime() + 60_000), lifecycleGroupId),
      60_000,
    );
    expect(fresh?.id).toBe(freshId);

    const sentAt = new Date(freshOpened.getTime() + 10_000);
    await publishSpawn(freshId, sentAt);

    const publication = await pool.query<{ published_at: Date; expires_at: Date }>(
      "SELECT published_at, expires_at FROM competitive_spawns WHERE id = $1",
      [freshId],
    );
    expect(publication.rows[0]?.published_at.getTime()).toBe(sentAt.getTime());
    expect(publication.rows[0]?.expires_at.getTime()).toBe(sentAt.getTime() + 5 * 60_000);

    const expired = await repository.expireDue(new Date(sentAt.getTime() + 5 * 60_000 + 1), 100);
    expect(expired).toBe(1);

    const fled = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_messages WHERE idempotency_key = $1",
      [`competitive-spawn:${freshId}:fled`],
    );
    expect(fled.rows[0]?.count).toBe("1");
  });
  it("preserves frozen shiny IVs and nature when Pokemon bonus is granted", async () => {
    const shinyGroupId = randomUUID();
    const shinyChatRef = `120363-shiny-${shinyGroupId}@g.us`;
    await pool.query(
      `INSERT INTO community_groups(
         id, provider, chat_ref, role, display_name, status
       ) VALUES ($1, 'baileys', $2, 'GAME', 'V65 Shiny Freeze Test', 'ACTIVE')`,
      [shinyGroupId, shinyChatRef],
    );

    const shinySpawnId = randomUUID();
    const openedAt = new Date();
    const frozenSnapshot: WildPokemonSnapshot = {
      ...snapshot,
      level: 27,
      currentHp: 41,
      maxHp: 41,
      shiny: true,
      ivs: {
        hp: 31,
        attack: 30,
        defense: 29,
        spAttack: 28,
        spDefense: 27,
        speed: 26,
      },
    };

    const opened = await repository.createOpen(
      {
        ...spawnWrite(
          shinySpawnId,
          openedAt,
          new Date(openedAt.getTime() + 5 * 60_000),
          shinyGroupId,
        ),
        chatRef: shinyChatRef,
        level: frozenSnapshot.level,
        shiny: frozenSnapshot.shiny,
        snapshot: frozenSnapshot,
      },
      60_000,
    );
    expect(opened?.id).toBe(shinySpawnId);

    const sentAt = new Date(openedAt.getTime() + 1_000);
    await publishSpawn(shinySpawnId, sentAt);

    const shinyInboxId = randomUUID();
    await insertInbox(shinyInboxId, playerA, "shiny-frozen-bonus");

    const result = await repository.claimCorrect({
      spawnId: shinySpawnId,
      inboxMessageId: shinyInboxId,
      playerId: playerA,
      senderRef: "5511000000077@s.whatsapp.net",
      normalizedGuess: "pikachu",
      idempotencyKey: "winner-shiny-frozen-bonus",
      correlationId: randomUUID(),
      rewardKindRoll: 0,
      rewardAmountRoll: 0,
      rewardItemRoll: 0,
      pokemonBonusRoll: 0,
      now: new Date(sentAt.getTime() + 1_000),
    });

    expect(result.kind).toBe("WON");
    if (result.kind !== "WON") return;
    expect(result.pokemonBonus).toBe(true);
    expect(result.pokemonInstanceId).not.toBeNull();

    const instance = await pool.query<{
      form_id: string;
      level: number;
      current_hp: number;
      gender: string | null;
      shiny: boolean;
      ability_id: string | null;
      nature_id: string;
      iv_hp: number;
      iv_attack: number;
      iv_defense: number;
      iv_sp_attack: number;
      iv_sp_defense: number;
      iv_speed: number;
    }>(
      `SELECT
         instance.form_id,
         instance.level,
         instance.current_hp,
         instance.gender,
         instance.shiny,
         instance.ability_id,
         training.nature_id,
         training.iv_hp,
         training.iv_attack,
         training.iv_defense,
         training.iv_sp_attack,
         training.iv_sp_defense,
         training.iv_speed
       FROM pokemon_instances instance
       JOIN pokemon_training_values training
         ON training.pokemon_instance_id = instance.id
       WHERE instance.id = $1`,
      [result.pokemonInstanceId],
    );

    expect(instance.rows[0]).toEqual({
      form_id: frozenSnapshot.formId,
      level: frozenSnapshot.level,
      current_hp: frozenSnapshot.currentHp,
      gender: frozenSnapshot.gender,
      shiny: frozenSnapshot.shiny,
      ability_id: frozenSnapshot.abilityId,
      nature_id: frozenSnapshot.natureId,
      iv_hp: frozenSnapshot.ivs.hp,
      iv_attack: frozenSnapshot.ivs.attack,
      iv_defense: frozenSnapshot.ivs.defense,
      iv_sp_attack: frozenSnapshot.ivs.spAttack,
      iv_sp_defense: frozenSnapshot.ivs.spDefense,
      iv_speed: frozenSnapshot.ivs.speed,
    });

    const persistedMoves = await pool.query<{
      slot_no: number;
      move_id: string;
      pp_current: number | null;
    }>(
      `SELECT slot_no, move_id, pp_current
       FROM pokemon_move_slots
       WHERE pokemon_instance_id = $1
       ORDER BY slot_no`,
      [result.pokemonInstanceId],
    );

    expect(persistedMoves.rows).toEqual(
      frozenSnapshot.moves.map((move, index) => ({
        slot_no: index + 1,
        move_id: move.moveId,
        pp_current: move.ppCurrent,
      })),
    );
  });

  it("keeps active spawns independent across different groups", async () => {
    const groupA = randomUUID();
    const groupB = randomUUID();
    const chatA = `120363-independent-a-${groupA}@g.us`;
    const chatB = `120363-independent-b-${groupB}@g.us`;

    await pool.query(
      `INSERT INTO community_groups(
         id, provider, chat_ref, role, display_name, status
       ) VALUES
         ($1, 'baileys', $2, 'GAME', 'V65 Independent A', 'ACTIVE'),
         ($3, 'baileys', $4, 'GAME', 'V65 Independent B', 'ACTIVE')`,
      [groupA, chatA, groupB, chatB],
    );

    const openedAt = new Date();
    const spawnA = randomUUID();
    const spawnB = randomUUID();

    const openedA = await repository.createOpen(
      {
        ...spawnWrite(spawnA, openedAt, new Date(openedAt.getTime() + 5 * 60_000), groupA),
        chatRef: chatA,
      },
      60_000,
    );
    const openedB = await repository.createOpen(
      {
        ...spawnWrite(spawnB, openedAt, new Date(openedAt.getTime() + 5 * 60_000), groupB),
        chatRef: chatB,
      },
      60_000,
    );

    expect(openedA?.id).toBe(spawnA);
    expect(openedB?.id).toBe(spawnB);

    // createOpen reserves an unpublished OPEN, which activeForGroup intentionally hides
    // until the image outbox is SENT and publication is reconciled.
    const sentAtA = new Date(openedAt.getTime() + 1_000);
    const sentAtB = new Date(openedAt.getTime() + 2_000);
    await publishSpawn(spawnA, sentAtA);
    await publishSpawn(spawnB, sentAtB);

    const activeA = await repository.activeForGroup(groupA);
    const activeB = await repository.activeForGroup(groupB);
    expect(activeA?.id).toBe(spawnA);
    expect(activeB?.id).toBe(spawnB);
    expect(activeA?.communityGroupId).toBe(groupA);
    expect(activeB?.communityGroupId).toBe(groupB);

    await expect(repository.canOpen(groupA, new Date(), 60_000)).resolves.toBe(false);
    await expect(repository.canOpen(groupB, new Date(), 60_000)).resolves.toBe(false);
  });
});
