import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdminAutoBattleControl } from "../../src/platform/battle/postgres-admin-auto-battle-control.js";
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

describe("admin automatic PVE battle control", () => {
  const dbName = `pokemon_auto_battle_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "auto-battle-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    const deadline = Date.now() + 5_000;
    while (true) {
      const active = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname=$1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (active.rows[0]?.count === "0") break;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for auto battle DB to close");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("atomically converts fresh player controllers to AUTO and locks the turn window", async () => {
    const rulesetId = randomUUID();
    const releaseId = randomUUID();
    const playerId = randomUUID();
    const speciesId = randomUUID();
    const formId = randomUUID();
    const pokemonInstanceId = randomUUID();
    const battleId = randomUUID();
    const playerSideId = randomUUID();
    const wildSideId = randomUUID();
    const playerParticipantId = randomUUID();
    const wildParticipantId = randomUUID();
    const windowId = randomUUID();

    await pool.query(
      `INSERT INTO rulesets(id,key,version,engine_contract_version,config,status)
       VALUES ($1,$2,1,1,'{}'::jsonb,'DRAFT')`,
      [rulesetId, `auto-${rulesetId}`],
    );
    await pool.query(
      `INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id)
       VALUES ($1,99001,'AUTO Battle Test','DRAFT',$2)`,
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO pokemon_species(id,national_dex,slug) VALUES ($1,999,'auto-battle-testmon')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES ($1,$2,'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      `INSERT INTO pokemon_instances(
         id,owner_player_id,form_id,level,current_hp,origin_type
       ) VALUES ($1,$2,$3,5,20,'TEST')`,
      [pokemonInstanceId, playerId, formId],
    );
    await pool.query(
      `INSERT INTO battles(
         id,battle_type,status,content_release_id,ruleset_id,
         turn_number,version,rng_seed_ciphertext,rng_seed_iv,rng_seed_auth_tag,
         rng_seed_key_version,rng_counter
       ) VALUES ($1,'WILD','ACTIVE',$2,$3,0,0,$4,$5,$6,1,0)`,
      [
        battleId,
        releaseId,
        rulesetId,
        Buffer.alloc(32, 1),
        Buffer.alloc(12, 2),
        Buffer.alloc(16, 3),
      ],
    );
    await pool.query(
      `INSERT INTO battle_sides(id,battle_id,side_no,controller_kind,player_id)
       VALUES ($1,$3,1,'PLAYER',$4),($2,$3,2,'WILD',NULL)`,
      [playerSideId, wildSideId, battleId, playerId],
    );
    await pool.query(
      `INSERT INTO battle_participants(
         id,battle_id,battle_side_id,pokemon_instance_id,participant_kind,roster_position,active_member,snapshot
       ) VALUES
         ($1,$5,$3,$6,'PLAYER_POKEMON',1,TRUE,'{}'::jsonb),
         ($2,$5,$4,NULL,'WILD_POKEMON',1,TRUE,'{}'::jsonb)`,
      [
        playerParticipantId,
        wildParticipantId,
        playerSideId,
        wildSideId,
        battleId,
        pokemonInstanceId,
      ],
    );
    await pool.query(
      `INSERT INTO battle_participant_controllers(
         participant_id,battle_id,kind,player_id,admin_principal_id,revision
       ) VALUES
         ($1,$3,'PLAYER',$4,NULL,0),
         ($2,$3,'AUTO',NULL,NULL,0)`,
      [playerParticipantId, wildParticipantId, battleId, playerId],
    );
    await pool.query(
      `INSERT INTO battle_state_snapshots(
         battle_id,version,schema_version,state
       ) VALUES ($1,0,1,'{}'::jsonb)`,
      [battleId],
    );
    await pool.query(
      `INSERT INTO battle_turn_windows(
         id,battle_id,battle_version,turn_number,status,opened_at,deadline_at,
         revision,required_controllers
       ) VALUES ($1,$2,0,0,'COLLECTING',now(),now()+interval '5 minutes',0,$3::jsonb)`,
      [
        windowId,
        battleId,
        JSON.stringify([
          {
            participantId: playerParticipantId,
            sideNo: 1,
            kind: "PLAYER",
            playerId,
            adminPrincipalId: null,
            revision: 0,
          },
        ]),
      ],
    );

    expect(await new PostgresAdminAutoBattleControl(pool).automatePlayers(battleId)).toEqual({
      automated: 1,
    });

    expect(
      (
        await pool.query(
          `SELECT kind,player_id,admin_principal_id,revision::int
           FROM battle_participant_controllers
           WHERE participant_id=$1`,
          [playerParticipantId],
        )
      ).rows,
    ).toEqual([{ kind: "AUTO", player_id: null, admin_principal_id: null, revision: 1 }]);

    expect(
      (
        await pool.query(
          `SELECT status,required_controllers,locked_at IS NOT NULL AS locked,revision::int
           FROM battle_turn_windows
           WHERE id=$1`,
          [windowId],
        )
      ).rows,
    ).toEqual([{ status: "LOCKED", required_controllers: [], locked: true, revision: 1 }]);

    expect(
      (
        await pool.query(
          `SELECT old_kind,new_kind,old_player_id,new_player_id,previous_revision::int,resulting_revision::int
           FROM battle_participant_controller_events
           WHERE participant_id=$1
           ORDER BY resulting_revision DESC
           LIMIT 1`,
          [playerParticipantId],
        )
      ).rows,
    ).toEqual([
      {
        old_kind: "PLAYER",
        new_kind: "AUTO",
        old_player_id: playerId,
        new_player_id: null,
        previous_revision: 0,
        resulting_revision: 1,
      },
    ]);
  });
});
