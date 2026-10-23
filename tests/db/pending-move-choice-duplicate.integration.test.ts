import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresProgressionRepository } from "../../src/platform/progression/postgres-progression-repository.js";

const databaseName = `pokemon_move_choice_duplicate_${process.pid}_${Date.now()}`;

function databaseUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/" + name;
  return url.toString();
}

interface ChoiceFixture {
  readonly playerId: string;
  readonly pokemonId: string;
  readonly offeredMoveId: string;
  readonly existingMoveIds: readonly string[];
  readonly firstChoiceId: string;
  readonly secondChoiceId: string;
}

describe.sequential("pending move choices cannot duplicate already learned moves", () => {
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresProgressionRepository;

  async function fixture(): Promise<ChoiceFixture> {
    const playerId = randomUUID();
    const rulesetId = randomUUID();
    const releaseId = randomUUID();
    const speciesId = randomUUID();
    const formId = randomUUID();
    const typeId = randomUUID();
    const pokemonId = randomUUID();
    const existingMoveIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const offeredMoveId = randomUUID();
    const firstChoiceId = randomUUID();
    const secondChoiceId = randomUUID();

    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
       VALUES ($1,$2,1,1,'{}'::jsonb,'DRAFT')`,
      [rulesetId, "move-choice-" + rulesetId],
    );
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES ($1,$2,$3,'DRAFT',$4)",
      [releaseId, Date.now() + Math.floor(Math.random() * 10000), "Move choice isolated test", rulesetId],
    );
    await pool.query("INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,$2,$3)", [
      speciesId,
      386,
      "choice-species-" + speciesId,
    ]);
    await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,$3)", [
      formId,
      speciesId,
      "choice-form-" + formId,
    ]);
    await pool.query("INSERT INTO pokemon_types(id,slug) VALUES ($1,$2)", [
      typeId,
      "choice-type-" + typeId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id,owner_player_id,form_id,level,current_hp,origin_type
       ) VALUES ($1,$2,$3,19,40,'TEST')`,
      [pokemonId, playerId, formId],
    );
    for (const [index, moveId] of [...existingMoveIds, offeredMoveId].entries()) {
      await pool.query("INSERT INTO moves(id,slug) VALUES ($1,$2)", [
        moveId,
        "choice-move-" + moveId,
      ]);
      if (index < 4) {
        await pool.query(
          "INSERT INTO pokemon_move_slots(pokemon_instance_id,slot_no,move_id,pp_current) VALUES ($1,$2,$3,20)",
          [pokemonId, index + 1, moveId],
        );
      }
    }
    await pool.query(
      `INSERT INTO move_revisions(
         id,content_release_id,move_id,display_name,type_id,category,power,accuracy,max_pp,active
       ) VALUES ($1,$2,$3,'Learned Move',$4,'PHYSICAL',40,100,20,TRUE)`,
      [randomUUID(), releaseId, offeredMoveId, typeId],
    );
    for (const [index, choiceId] of [firstChoiceId, secondChoiceId].entries()) {
      await pool.query(
        `INSERT INTO pending_move_choices(
           id,pokemon_instance_id,content_release_id,move_id,learn_level,source_type,
           source_id,correlation_id
         ) VALUES ($1,$2,$3,$4,$5,'BATTLE_REWARD',$6,$7)`,
        [choiceId, pokemonId, releaseId, offeredMoveId, index === 0 ? 16 : 19, randomUUID(), randomUUID()],
      );
    }
    return {
      playerId,
      pokemonId,
      offeredMoveId,
      existingMoveIds,
      firstChoiceId,
      secondChoiceId,
    };
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl("postgres"), max: 1 });
    await adminPool.query('CREATE DATABASE "' + databaseName + '"');
    pool = new Pool({ connectionString: databaseUrl(databaseName), max: 6 });
    await runMigrations(pool, { appliedBy: "move-choice-duplicate-test" });
    repository = new PostgresProgressionRepository(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
      await adminPool.end();
    }
  });

  it("rejects a later duplicate pending choice without erasing a different move", async () => {
    const value = await fixture();
    const first = await repository.resolveMoveChoice({
      choiceId: value.firstChoiceId,
      playerId: value.playerId,
      replaceSlotNo: 1,
      correlationId: randomUUID(),
    });
    expect(first).toMatchObject({ kind: "RESOLVED", result: { status: "RESOLVED" } });

    const second = await repository.resolveMoveChoice({
      choiceId: value.secondChoiceId,
      playerId: value.playerId,
      replaceSlotNo: 2,
      correlationId: randomUUID(),
    });
    expect(second).toMatchObject({
      kind: "CONFLICT",
      reason: "Pokemon already knows the move offered by this pending choice",
    });

    const slots = await pool.query<{ slot_no: number; move_id: string }>(
      "SELECT slot_no,move_id FROM pokemon_move_slots WHERE pokemon_instance_id=$1 ORDER BY slot_no",
      [value.pokemonId],
    );
    expect(slots.rows).toEqual([
      { slot_no: 1, move_id: value.offeredMoveId },
      { slot_no: 2, move_id: value.existingMoveIds[1] },
      { slot_no: 3, move_id: value.existingMoveIds[2] },
      { slot_no: 4, move_id: value.existingMoveIds[3] },
    ]);
    const choices = await pool.query<{ id: string; status: string }>(
      "SELECT id,status FROM pending_move_choices WHERE pokemon_instance_id=$1",
      [value.pokemonId],
    );
    expect(choices.rows).toContainEqual({ id: value.secondChoiceId, status: "PENDING" });

    const skipped = await repository.resolveMoveChoice({
      choiceId: value.secondChoiceId,
      playerId: value.playerId,
      replaceSlotNo: null,
      correlationId: randomUUID(),
    });
    expect(skipped).toMatchObject({ kind: "RESOLVED", result: { status: "SKIPPED" } });
    expect(
      await repository.resolveMoveChoice({
        choiceId: value.secondChoiceId,
        playerId: value.playerId,
        replaceSlotNo: null,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({ kind: "REPLAYED", result: { status: "SKIPPED", replayed: true } });
  });

  it("serializes two simultaneous pending choices for the same move", async () => {
    const value = await fixture();
    const results = await Promise.all([
      repository.resolveMoveChoice({
        choiceId: value.firstChoiceId,
        playerId: value.playerId,
        replaceSlotNo: 1,
        correlationId: randomUUID(),
      }),
      repository.resolveMoveChoice({
        choiceId: value.secondChoiceId,
        playerId: value.playerId,
        replaceSlotNo: 2,
        correlationId: randomUUID(),
      }),
    ]);
    expect(results.filter((entry) => entry.kind === "RESOLVED")).toHaveLength(1);
    expect(results.filter((entry) => entry.kind === "CONFLICT")).toHaveLength(1);
    const repeated = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pokemon_move_slots WHERE pokemon_instance_id=$1 AND move_id=$2",
      [value.pokemonId, value.offeredMoveId],
    );
    expect(repeated.rows[0]?.count).toBe(1);
  });
});
