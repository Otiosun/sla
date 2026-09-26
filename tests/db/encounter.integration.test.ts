import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BattleService } from "../../src/modules/battle/service.js";
import { EncounterService } from "../../src/modules/encounter/service.js";
import { PostgresBattleParticipantControllerRepository } from "../../src/platform/battle/postgres-battle-participant-controller-repository.js";
import { PostgresBattleRepository } from "../../src/platform/battle/postgres-battle-repository.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresEncounterRepository } from "../../src/platform/encounter/postgres-encounter-repository.js";
import { AesEncounterSeedProvider } from "../../src/platform/rng/encrypted-seed-provider.js";
import { createEncounterId, createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import type { Result } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

const FEATURE_ENABLED = { enabled: true, reason: null } as const;
const FIXED_NOW = new Date("2026-08-26T03:00:00.000Z");

interface Fixture {
  readonly rulesetId: string;
  readonly releaseId: string;
  readonly areaId: string;
  readonly speciesId: string;
}

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function service(
  pool: Pool,
  clock: ManualClock,
  seedFactory: () => Buffer = () => Buffer.alloc(32, 0x4c),
): EncounterService {
  return new EncounterService(
    new PostgresEncounterRepository(pool),
    new AesEncounterSeedProvider(Buffer.alloc(32, 0xa5), 1, seedFactory),
    clock,
    FEATURE_ENABLED,
  );
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const normalTypeId = randomUUID();
  const flyingTypeId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const abilityId = randomUUID();
  const natureId = randomUUID();
  const moveId = randomUUID();
  const encounterTableId = randomUUID();
  const encounterRevisionId = randomUUID();

  const rulesetConfig = {
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
    },
    capture: {
      model: "POKEMON_INSPIRED_V1",
      maxProbabilityBasisPoints: 9_500,
      allowedEncounterStates: ["IN_BATTLE"],
    },
    encounter: { expirationSeconds: 60 },
    defeat: { automaticMoneyLoss: false },
    narrative: { authority: "N0_FLAVOR_ONLY" },
  };

  await client.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, 'phase8-encounter-test', 1, 1, $2::jsonb, 'DRAFT')`,
    [rulesetId, JSON.stringify(rulesetConfig)],
  );
  await client.query(
    `UPDATE rulesets
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         config_fingerprint = $2
     WHERE id = $1`,
    [rulesetId, "8".repeat(64)],
  );
  await client.query(
    "UPDATE rulesets SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [rulesetId],
  );

  await client.query("INSERT INTO regions(id, slug) VALUES ($1, 'phase8-kanto')", [regionId]);
  await client.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, 'phase8-route')", [
    areaId,
    regionId,
  ]);
  await client.query(
    "INSERT INTO pokemon_types(id, slug) VALUES ($1, 'phase8-normal'), ($2, 'phase8-flying')",
    [normalTypeId, flyingTypeId],
  );
  await client.query(
    "INSERT INTO pokemon_species(id, national_dex, slug) VALUES ($1, 901, 'phase8-testmon')",
    [speciesId],
  );
  await client.query("INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, 'default')", [
    formId,
    speciesId,
  ]);
  await client.query("INSERT INTO abilities(id, slug) VALUES ($1, 'phase8-keen-eye')", [abilityId]);
  await client.query("INSERT INTO natures(id, slug) VALUES ($1, 'phase8-hardy')", [natureId]);
  await client.query("INSERT INTO moves(id, slug) VALUES ($1, 'phase8-tackle')", [moveId]);
  await client.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, 8001, 'Phase 8 Encounter Integration', 'DRAFT', $2)`,
    [releaseId, rulesetId],
  );

  await client.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name)
     VALUES ($1, $2, $3, 'Phase 8 Kanto')`,
    [randomUUID(), releaseId, regionId],
  );
  await client.query(
    `INSERT INTO area_revisions(id, content_release_id, area_id, display_name, data)
     VALUES ($1, $2, $3, 'Phase 8 Route', $4::jsonb)`,
    [
      randomUUID(),
      releaseId,
      areaId,
      JSON.stringify({
        schemaVersion: 1,
        kind: "ROUTE",
        safePoint: true,
        startingArea: true,
        relocationPriority: 0,
      }),
    ],
  );
  await client.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name)
     VALUES ($1, $3, $4, 'Normal'), ($2, $3, $5, 'Flying')`,
    [randomUUID(), randomUUID(), releaseId, normalTypeId, flyingTypeId],
  );
  await client.query(
    `INSERT INTO pokemon_species_revisions(
       id, content_release_id, species_id, display_name, catch_rate, base_exp
     ) VALUES ($1, $2, $3, 'Testmon', 255, 50)`,
    [randomUUID(), releaseId, speciesId],
  );
  await client.query(
    `INSERT INTO pokemon_form_revisions(
       id, content_release_id, form_id, display_name, type1_id, type2_id,
       base_hp, base_attack, base_defense, base_sp_attack, base_sp_defense, base_speed
     ) VALUES ($1, $2, $3, 'Testmon', $4, $5, 40, 45, 40, 35, 35, 56)`,
    [randomUUID(), releaseId, formId, normalTypeId, flyingTypeId],
  );
  await client.query(
    `INSERT INTO ability_revisions(id, content_release_id, ability_id, display_name)
     VALUES ($1, $2, $3, 'Keen Eye')`,
    [randomUUID(), releaseId, abilityId],
  );
  await client.query(
    `INSERT INTO nature_revisions(id, content_release_id, nature_id, display_name)
     VALUES ($1, $2, $3, 'Hardy')`,
    [randomUUID(), releaseId, natureId],
  );
  await client.query(
    `INSERT INTO move_revisions(
       id, content_release_id, move_id, display_name, type_id, category,
       power, accuracy, priority, max_pp
     ) VALUES ($1, $2, $3, 'Tackle', $4, 'PHYSICAL', 40, 100, 0, 35)`,
    [randomUUID(), releaseId, moveId, normalTypeId],
  );
  await client.query(
    `INSERT INTO pokemon_form_ability_options(
       id, content_release_id, form_id, ability_id, slot_kind
     ) VALUES ($1, $2, $3, $4, 'PRIMARY')`,
    [randomUUID(), releaseId, formId, abilityId],
  );
  await client.query(
    `INSERT INTO move_learnset_entries(
       id, content_release_id, form_id, move_id, learn_method
     ) VALUES ($1, $2, $3, $4, 'START')`,
    [randomUUID(), releaseId, formId, moveId],
  );
  await client.query(
    `INSERT INTO encounter_tables(id, area_id, slug)
     VALUES ($1, $2, 'grass')`,
    [encounterTableId, areaId],
  );
  await client.query(
    `INSERT INTO encounter_table_revisions(
       id, content_release_id, encounter_table_id, active, conditions
     ) VALUES ($1, $2, $3, TRUE, $4::jsonb)`,
    [
      encounterRevisionId,
      releaseId,
      encounterTableId,
      JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], blockedUnlockKeys: [] }),
    ],
  );
  await client.query(
    `INSERT INTO encounter_entries(
       id, encounter_table_revision_id, form_id, weight, min_level, max_level, active, conditions
     ) VALUES ($1, $2, $3, 100, 3, 5, TRUE, $4::jsonb)`,
    [
      randomUUID(),
      encounterRevisionId,
      formId,
      JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], blockedUnlockKeys: [] }),
    ],
  );

  await client.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "9".repeat(64)],
  );
  await client.query(
    "UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
    [releaseId],
  );
  await client.query(
    `INSERT INTO content_release_pointers(pointer_key, content_release_id)
     VALUES ('ACTIVE', $1)`,
    [releaseId],
  );

  return { rulesetId, releaseId, areaId, speciesId };
}

async function createEligiblePlayer(client: PoolClient, areaId: string): Promise<PlayerId> {
  const playerId = createPlayerId();
  await client.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
  await client.query(
    `INSERT INTO onboarding_states(player_id, state, starter_claim_key, completed_at)
     VALUES ($1, 'COMPLETE', $2, now())`,
    [playerId, `phase8-test:${playerId}`],
  );
  await client.query("INSERT INTO player_locations(player_id, area_id) VALUES ($1, $2)", [
    playerId,
    areaId,
  ]);
  return playerId;
}

describe("encounter PostgreSQL integration", () => {
  const dbName = `pokemon_encounter_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let fixture: Fixture;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 16 });
    await runMigrations(pool, { appliedBy: "phase8-vitest" });
    const client = await pool.connect();
    try {
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await pool.end();

    // pool.end() resolves after clients begin closing, but PostgreSQL can still
    // report a just-released backend for a few milliseconds. Dropping WITH
    // (FORCE) in that window kills the pg client and surfaces an unhandled
    // 57P01 in Vitest. Wait for the disposable database to become idle and
    // then drop it normally so real connection leaks still fail loudly.
    const deadline = Date.now() + 5_000;
    while (true) {
      const activeConnections = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (activeConnections.rows[0]?.count === "0") break;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for PostgreSQL connections to close for ${dbName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("replays duplicate creation across a logical restart without rerolling snapshot", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.areaId);
    client.release();
    const clock = new ManualClock(FIXED_NOW);

    const first = unwrap(
      await service(pool, clock).createOrReplay({ playerId, idempotencyKey: "whatsapp-message-1" }),
    );
    const restarted = unwrap(
      await service(pool, new ManualClock(new Date(FIXED_NOW.getTime() + 30_000))).createOrReplay({
        playerId,
        idempotencyKey: "whatsapp-message-1",
      }),
    );

    expect(restarted.encounterId).toBe(first.encounterId);
    expect(restarted.snapshot).toEqual(first.snapshot);
    expect(restarted.rngCounter).toBe(first.rngCounter);
    expect(restarted.expiresAt?.toISOString()).toBe("2026-08-26T03:01:00.000Z");
    const counts = await pool.query<{ encounters: string; snapshots: string }>(
      `SELECT
         (SELECT count(*)::text FROM encounters WHERE player_id = $1) AS encounters,
         (SELECT count(*)::text FROM encounter_snapshots snapshot
          JOIN encounters encounter ON encounter.id = snapshot.encounter_id
          WHERE encounter.player_id = $1) AS snapshots`,
      [playerId],
    );
    expect(counts.rows[0]).toEqual({ encounters: "1", snapshots: "1" });
  });

  it("creates one frozen shared encounter for a co-located durable party and replays it", async () => {
    const client = await pool.connect();
    let owner: PlayerId;
    let ally: PlayerId;
    try {
      owner = await createEligiblePlayer(client, fixture.areaId);
      ally = await createEligiblePlayer(client, fixture.areaId);
      const partyId = randomUUID();
      await client.query(`INSERT INTO player_parties(id,leader_player_id) VALUES ($1,$2)`, [
        partyId,
        owner,
      ]);
      await client.query(
        `INSERT INTO player_party_members(party_id,player_id) VALUES ($1,$2),($1,$3)`,
        [partyId, owner, ally],
      );
    } finally {
      client.release();
    }

    const first = unwrap(
      await service(pool, new ManualClock(FIXED_NOW)).createOrReplay({
        playerId: owner,
        participantPlayerIds: [owner, ally],
        idempotencyKey: "party-spawn",
      }),
    );
    const replay = unwrap(
      await service(pool, new ManualClock(new Date(FIXED_NOW.getTime() + 1_000))).createOrReplay({
        playerId: owner,
        participantPlayerIds: [owner, ally],
        idempotencyKey: "party-spawn",
      }),
    );

    expect(replay).toMatchObject({ encounterId: first.encounterId, snapshot: first.snapshot });
    expect(
      await new PostgresEncounterRepository(pool).read((tx) => tx.activeForPlayer(ally)),
    ).toMatchObject({ encounterId: first.encounterId });
    const participants = await pool.query(
      `SELECT player_id,role,pokemon_instance_ids FROM encounter_players
      WHERE encounter_id=$1 ORDER BY player_id`,
      [first.encounterId],
    );
    expect(participants.rows).toEqual([
      {
        player_id: [owner, ally].sort()[0],
        role: [owner, ally].sort()[0] === owner ? "OWNER" : "ALLY",
        pokemon_instance_ids: [],
      },
      {
        player_id: [owner, ally].sort()[1],
        role: [owner, ally].sort()[1] === owner ? "OWNER" : "ALLY",
        pokemon_instance_ids: [],
      },
    ]);
  });

  it("rejects an invalid requested party before creating an RNG seed", async () => {
    const client = await pool.connect();
    let owner: PlayerId;
    let ally: PlayerId;
    try {
      owner = await createEligiblePlayer(client, fixture.areaId);
      ally = await createEligiblePlayer(client, fixture.areaId);
      const partyId = randomUUID();
      await client.query(`INSERT INTO player_parties(id,leader_player_id) VALUES ($1,$2)`, [
        partyId,
        owner,
      ]);
      await client.query(
        `INSERT INTO player_party_members(party_id,player_id) VALUES ($1,$2),($1,$3)`,
        [partyId, owner, ally],
      );
    } finally {
      client.release();
    }

    let seedCalls = 0;
    const created = await service(pool, new ManualClock(FIXED_NOW), () => {
      seedCalls += 1;
      return Buffer.alloc(32, 0x4c);
    }).createOrReplay({
      playerId: owner,
      participantPlayerIds: [owner],
      idempotencyKey: "invalid-party-before-rng",
    });

    expect(created).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(seedCalls).toBe(0);
  });

  it("freezes allied rosters and initializes two real owners on one side through the runtime", async () => {
    const client = await pool.connect();
    let source: PlayerId;
    let owner: PlayerId;
    let ally: PlayerId;
    try {
      source = await createEligiblePlayer(client, fixture.areaId);
      owner = await createEligiblePlayer(client, fixture.areaId);
      ally = await createEligiblePlayer(client, fixture.areaId);
    } finally {
      client.release();
    }
    const generated = unwrap(
      await service(pool, new ManualClock(FIXED_NOW)).createOrReplay({
        playerId: source,
        idempotencyKey: "allied-snapshot-source",
      }),
    );
    const pokemonIds = [randomUUID(), randomUUID()];
    for (const [index, playerId] of [owner, ally].entries()) {
      await pool.query(
        `INSERT INTO pokemon_instances(id,owner_player_id,form_id,ability_id,level,current_hp,origin_type)
         VALUES ($1,$2,$3,$4,10,30,'TEST')`,
        [pokemonIds[index], playerId, generated.snapshot.formId, generated.snapshot.abilityId],
      );
      await pool.query(
        `INSERT INTO pokemon_training_values(pokemon_instance_id,nature_id)
        VALUES ($1,$2)`,
        [pokemonIds[index], generated.snapshot.natureId],
      );
      await pool.query(
        `INSERT INTO pokemon_move_slots(pokemon_instance_id,slot_no,move_id,pp_current)
        VALUES ($1,1,$2,35)`,
        [pokemonIds[index], generated.snapshot.moves[0]?.moveId],
      );
      await pool.query(
        `INSERT INTO pokemon_roster_slots(pokemon_instance_id,player_id,placement_kind,slot_no)
        VALUES ($1,$2,'TEAM',1)`,
        [pokemonIds[index], playerId],
      );
    }
    const repository = new PostgresEncounterRepository(pool);
    const encounterId = createEncounterId();
    const seed = {
      ciphertext: Buffer.alloc(32, 1),
      iv: Buffer.alloc(12, 2),
      authTag: Buffer.alloc(16, 3),
      keyVersion: 1,
    };
    const inserted = await repository.transaction((tx) =>
      tx.insertEncounter({
        encounterId,
        playerId: owner,
        participantPlayerIds: [ally, owner],
        areaId: fixture.areaId,
        contentReleaseId: fixture.releaseId,
        rulesetId: fixture.rulesetId,
        creationIdempotencyKey: "allied-runtime",
        seed,
        rngCounter: 0n,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        snapshot: generated.snapshot,
      }),
    );
    expect(await repository.read((tx) => tx.activeForPlayer(ally))).toMatchObject({ encounterId });
    expect(await repository.read((tx) => tx.byId(ally, encounterId))).toBeNull();
    const frozen = await pool.query(
      `SELECT player_id,side_no,role,pokemon_instance_ids FROM encounter_players
      WHERE encounter_id=$1 ORDER BY role`,
      [encounterId],
    );
    expect(frozen.rows).toEqual([
      { player_id: ally, side_no: 1, role: "ALLY", pokemon_instance_ids: [pokemonIds[1]] },
      { player_id: owner, side_no: 1, role: "OWNER", pokemon_instance_ids: [pokemonIds[0]] },
    ]);
    await expect(
      pool.query(`UPDATE encounter_players SET pokemon_instance_ids='{}' WHERE encounter_id=$1`, [
        encounterId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`DELETE FROM encounter_players WHERE encounter_id=$1`, [encounterId]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO encounter_players(encounter_id,player_id,side_no,role,active)
      VALUES ($1,$2,1,'ALLY',TRUE)`,
        [encounterId, createPlayerId()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A live roster move after creation cannot substitute the frozen battle roster.
    await pool.query(
      `UPDATE pokemon_roster_slots SET placement_kind='BOX',box_no=1 WHERE player_id=$1`,
      [ally],
    );
    const battleId = await repository.transaction((tx) =>
      tx.createBattle({ battleId: randomUUID(), encounter: inserted, seed }),
    );
    const battleRepository = new PostgresBattleRepository(pool, { turnWindowTtlMs: 60_000 });
    const battle = new BattleService(battleRepository, { decrypt: () => Buffer.alloc(32, 7) });
    const initialized = await battle.initialize(battleId);
    if (!initialized.ok) throw initialized.error;
    expect(initialized.value.state.sides).toHaveLength(2);
    expect(initialized.value.state.sides[0]?.slots).toHaveLength(2);
    expect(
      initialized.value.state.combatants
        .filter((entry) => entry.sideNo === 1)
        .map((entry) => entry.pokemonInstanceId),
    ).toEqual(pokemonIds);
    const controllers = await new PostgresBattleParticipantControllerRepository(pool).listByBattle(
      battleId,
    );
    expect(
      controllers
        .filter((entry) => entry.kind === "PLAYER")
        .map((entry) => entry.playerId)
        .sort(),
    ).toEqual([owner, ally].sort());
    const window = await new PostgresBattleTurnWindowRepository(pool).loadByBattleVersion(
      battleId,
      0,
    );
    if (!window.ok) throw new Error(window.error.message);
    expect(window.value.window.requiredControllers).toHaveLength(2);
    const actors = initialized.value.state.sides[0]?.slots;
    const target = initialized.value.state.sides[1]?.activeParticipantId;
    const [ownerActor, allyActor] = actors ?? [];
    if (ownerActor === undefined || allyActor === undefined || target === undefined) {
      throw new Error("Missing initialized actors");
    }
    const first = await battle.resolvePlayerTurn({
      battleId,
      playerId: owner,
      expectedVersion: 0,
      idempotencyKey: "allied-owner",
      action: {
        type: "USE_MOVE",
        actorParticipantId: ownerActor.activeParticipantId,
        targetParticipantId: target,
        moveSlot: 1,
      },
    });
    expect(first).toMatchObject({ ok: true, value: { pending: true } });
    const restarted = new BattleService(
      new PostgresBattleRepository(pool, { turnWindowTtlMs: 60_000 }),
      { decrypt: () => Buffer.alloc(32, 7) },
    );
    expect(await restarted.initialize(battleId)).toMatchObject({
      ok: true,
      value: { replayed: true },
    });
    const second = await restarted.resolvePlayerTurn({
      battleId,
      playerId: ally,
      expectedVersion: 0,
      idempotencyKey: "allied-ally",
      action: {
        type: "USE_MOVE",
        actorParticipantId: allyActor.activeParticipantId,
        targetParticipantId: target,
        moveSlot: 1,
      },
    });
    expect(second).toMatchObject({ ok: true, value: { state: { version: 1 } } });
  });

  it("serializes concurrent creation so only one incompatible encounter becomes active", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.areaId);
    client.release();
    const clock = new ManualClock(FIXED_NOW);
    const encounter = service(pool, clock);

    const results = await Promise.all([
      encounter.createOrReplay({ playerId, idempotencyKey: "concurrent-a" }),
      encounter.createOrReplay({ playerId, idempotencyKey: "concurrent-b" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.error.code === "ACTION_INVALID"),
    ).toHaveLength(1);

    const persisted = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM encounters WHERE player_id = $1",
      [playerId],
    );
    expect(persisted.rows[0]?.count).toBe("1");
  });

  it("observes once, enforces pinned capture policy and links exactly one battle", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.areaId);
    client.release();
    const clock = new ManualClock(FIXED_NOW);
    const encounter = service(pool, clock);

    const created = unwrap(
      await encounter.createOrReplay({ playerId, idempotencyKey: "battle-flow" }),
    );
    const presented = unwrap(
      await encounter.observe({ playerId, encounterId: created.encounterId, expectedRevision: 0n }),
    );
    expect(presented.status).toBe("PRESENTED");
    expect(presented.revision).toBe(1n);

    const observedReplay = unwrap(
      await encounter.observe({ playerId, encounterId: created.encounterId, expectedRevision: 0n }),
    );
    expect(observedReplay.revision).toBe(1n);

    const pokedex = await pool.query<{
      seen_count: string;
      caught_count: string;
      first_seen_at: Date | null;
      last_seen_at: Date | null;
      first_caught_at: Date | null;
      last_caught_at: Date | null;
    }>(
      `SELECT seen_count::text, caught_count::text,
              first_seen_at, last_seen_at, first_caught_at, last_caught_at
       FROM player_pokedex_species
       WHERE player_id = $1 AND species_id = $2`,
      [playerId, fixture.speciesId],
    );
    expect(pokedex.rows[0]).toMatchObject({
      seen_count: "1",
      caught_count: "0",
      first_caught_at: null,
      last_caught_at: null,
    });
    expect(pokedex.rows[0]?.first_seen_at).toBeInstanceOf(Date);
    expect(pokedex.rows[0]?.last_seen_at).toBeInstanceOf(Date);

    const engaged = unwrap(
      await encounter.engage({ playerId, encounterId: created.encounterId, expectedRevision: 1n }),
    );
    const earlyCapture = await encounter.beginCapture({
      playerId,
      encounterId: created.encounterId,
      expectedRevision: engaged.revision,
    });
    expect(earlyCapture).toMatchObject({ ok: false });

    const battle = unwrap(
      await encounter.startBattle({
        playerId,
        encounterId: created.encounterId,
        expectedRevision: engaged.revision,
      }),
    );
    expect(battle.replayed).toBe(false);
    expect(battle.encounter.status).toBe("IN_BATTLE");

    const battleReplay = unwrap(
      await encounter.startBattle({
        playerId,
        encounterId: created.encounterId,
        expectedRevision: engaged.revision,
      }),
    );
    expect(battleReplay.replayed).toBe(true);
    expect(battleReplay.battleId).toBe(battle.battleId);

    const battleCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM battles WHERE encounter_id = $1",
      [created.encounterId],
    );
    expect(battleCount.rows[0]?.count).toBe("1");

    const captureResolving = unwrap(
      await encounter.beginCapture({
        playerId,
        encounterId: created.encounterId,
        expectedRevision: battle.encounter.revision,
      }),
    );
    expect(captureResolving.status).toBe("CAPTURE_RESOLVING");
  });

  it("flee is idempotent and persists terminal close metadata", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.areaId);
    client.release();
    const clock = new ManualClock(FIXED_NOW);
    const encounter = service(pool, clock);
    const created = unwrap(
      await encounter.createOrReplay({ playerId, idempotencyKey: "flee-flow" }),
    );

    const fled = unwrap(
      await encounter.flee({ playerId, encounterId: created.encounterId, expectedRevision: 0n }),
    );
    expect(fled.status).toBe("FLED");
    expect(fled.closedAt?.toISOString()).toBe(FIXED_NOW.toISOString());
    const replay = unwrap(
      await encounter.flee({ playerId, encounterId: created.encounterId, expectedRevision: 0n }),
    );
    expect(replay.status).toBe("FLED");
    expect(replay.revision).toBe(fled.revision);
  });

  it("expires only safe pre-battle states and leaves IN_BATTLE encounters untouched", async () => {
    const clock = new ManualClock(FIXED_NOW);
    const expiringClient = await pool.connect();
    const expiringPlayer = await createEligiblePlayer(expiringClient, fixture.areaId);
    const battlePlayer = await createEligiblePlayer(expiringClient, fixture.areaId);
    expiringClient.release();
    const encounter = service(pool, clock);

    const expiring = unwrap(
      await encounter.createOrReplay({ playerId: expiringPlayer, idempotencyKey: "expires" }),
    );
    const battleCreated = unwrap(
      await encounter.createOrReplay({ playerId: battlePlayer, idempotencyKey: "battle-survives" }),
    );
    const battlePresented = unwrap(
      await encounter.observe({
        playerId: battlePlayer,
        encounterId: battleCreated.encounterId,
        expectedRevision: 0n,
      }),
    );
    const battleEngaged = unwrap(
      await encounter.engage({
        playerId: battlePlayer,
        encounterId: battleCreated.encounterId,
        expectedRevision: battlePresented.revision,
      }),
    );
    unwrap(
      await encounter.startBattle({
        playerId: battlePlayer,
        encounterId: battleCreated.encounterId,
        expectedRevision: battleEngaged.revision,
      }),
    );

    clock.advanceMs(61_000);
    const cleanup = unwrap(await encounter.expireDue());
    expect(cleanup.expiredEncounterIds).toContain(expiring.encounterId);
    expect(cleanup.expiredEncounterIds).not.toContain(battleCreated.encounterId);

    const expiredView = unwrap(await encounter.get(expiringPlayer, expiring.encounterId));
    expect(expiredView.status).toBe("EXPIRED");
    expect(expiredView.closedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(unwrap(await encounter.get(battlePlayer, battleCreated.encounterId)).status).toBe(
      "IN_BATTLE",
    );
  });

  it("keeps legacy direct encounter inserts compatible while assigning a stable fallback key", async () => {
    const client = await pool.connect();
    const playerId = await createEligiblePlayer(client, fixture.areaId);
    const encounterId = randomUUID();
    await client.query(
      `INSERT INTO encounters(
         id, player_id, area_id, status, content_release_id, ruleset_id,
         rng_seed_ciphertext, rng_seed_iv, rng_seed_auth_tag, rng_seed_key_version
       ) VALUES ($1, $2, $3, 'PRESENTED', $4, $5, $6, $7, $8, 1)`,
      [
        encounterId,
        playerId,
        fixture.areaId,
        fixture.releaseId,
        fixture.rulesetId,
        Buffer.alloc(32),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ],
    );
    const row = await client.query<{ creation_idempotency_key: string }>(
      "SELECT creation_idempotency_key FROM encounters WHERE id = $1",
      [encounterId],
    );
    client.release();
    expect(row.rows[0]?.creation_idempotency_key).toBe(`legacy:${encounterId}`);
  });
});
