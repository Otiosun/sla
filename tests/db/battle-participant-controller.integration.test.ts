import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBattleParticipantControllerRepository } from "../../src/platform/battle/postgres-battle-participant-controller-repository.js";
import { PostgresBattleTurnWindowRepository } from "../../src/platform/battle/postgres-battle-turn-window-repository.js";
import { loadMigrations } from "../../src/platform/db/migrations.js";
import { battleState, playerCombatant, wildCombatant } from "../battle/fixtures.js";

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

describe("participant controllers PostgreSQL", () => {
  const dbName = `pokemon_controllers_${process.pid}_${Date.now()}`;
  let pool: Pool;
  let adminPool: Pool;
  let fixture: Fixture;
  const narrator = randomUUID();
  const wild = randomUUID();
  const ally = randomUUID();
  const windowId = randomUUID();

  beforeAll(async () => {
    const url = new URL(
      process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55439/postgres",
    );
    url.pathname = "/postgres";
    adminPool = new Pool({ connectionString: url.toString() });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString() });
    const migrations = await loadMigrations();
    const client = await pool.connect();
    try {
      for (const migration of migrations.filter((entry) => entry.version < 42n)) {
        await client.query(migration.sql);
      }
      fixture = await seedFixture(client);
      for (const migration of migrations.filter((entry) => entry.version >= 42n)) {
        await client.query(migration.sql);
      }
    } finally {
      client.release();
    }
    await pool.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1::uuid,$1::text,'ACTIVE')",
      [narrator],
    );
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,participant_kind,roster_position,snapshot)
      SELECT $1,battle_id,battle_side_id,'WILD_POKEMON',2,'{}' FROM battle_participants WHERE id=$2`,
      [wild, fixture.actorB],
    );
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,pokemon_instance_id,participant_kind,roster_position,snapshot)
      SELECT $1,battle_id,battle_side_id,pokemon_instance_id,'PLAYER_POKEMON',2,'{}' FROM battle_participants WHERE id=$2`,
      [ally, fixture.actorA],
    );
    await pool.query(
      `INSERT INTO battle_turn_windows(id,battle_id,battle_version,turn_number,status,opened_at,deadline_at)
      VALUES ($1,$2,7,4,'COLLECTING',now(),now()+interval '5 minutes')`,
      [windowId, fixture.battleId],
    );
  }, 30000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool?.end();
  });

  it("backfills legacy players and reloads two distinct controllers on the same side", async () => {
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    expect(await repository.get(fixture.actorA)).toMatchObject({
      kind: "PLAYER",
      playerId: fixture.playerA,
      revision: 0,
    });
    expect(await repository.get(fixture.actorB)).toMatchObject({
      kind: "PLAYER",
      playerId: fixture.playerB,
      revision: 0,
    });
    await repository.initialize({
      participantId: ally,
      battleId: fixture.battleId,
      kind: "PLAYER",
      playerId: fixture.playerB,
      adminPrincipalId: null,
    });
    const reloaded = await new PostgresBattleParticipantControllerRepository(pool).listByBattle(
      fixture.battleId,
    );
    expect(reloaded).toHaveLength(3);
    expect(reloaded.find((entry) => entry.participantId === ally)?.playerId).toBe(fixture.playerB);
    expect(await repository.get(randomUUID())).toBeNull();
    expect(await repository.listByBattle(randomUUID())).toEqual([]);
    expect(
      await repository.transition({
        participantId: ally,
        expectedRevision: 0,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toBeNull();
  });

  it("initializes exactly once concurrently, CAS swaps and preserves append-only history", async () => {
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    const input = {
      participantId: wild,
      battleId: fixture.battleId,
      kind: "AUTO" as const,
      playerId: null,
      adminPrincipalId: null,
    };
    const initial = await Promise.all([repository.initialize(input), repository.initialize(input)]);
    expect(initial[0]).toEqual(initial[1]);
    const transition = {
      participantId: wild,
      expectedRevision: 0,
      kind: "NARRATOR" as const,
      adminPrincipalId: narrator,
    };
    const results = await Promise.all([
      repository.transition(transition),
      repository.transition(transition),
    ]);
    expect(results.filter((entry) => entry !== null)).toHaveLength(1);
    expect(await repository.get(wild)).toMatchObject({
      kind: "NARRATOR",
      revision: 1,
      adminPrincipalId: narrator,
    });
    expect(await repository.initialize(input)).toMatchObject({ kind: "NARRATOR", revision: 1 });
    expect(
      await repository.transition({ ...transition, kind: "AUTO", adminPrincipalId: null }),
    ).toBeNull();
    expect(
      await repository.transition({
        ...transition,
        expectedRevision: 1,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).toMatchObject({ kind: "AUTO", revision: 2 });
    const history = await pool.query(
      "SELECT * FROM battle_participant_controller_events WHERE participant_id=$1 ORDER BY resulting_revision",
      [wild],
    );
    expect(history.rows.map((row) => row.new_kind)).toEqual(["AUTO", "NARRATOR", "AUTO"]);
    expect(history.rows[2]).toMatchObject({
      old_kind: "NARRATOR",
      actor_admin_principal_id: narrator,
      previous_revision: "1",
      resulting_revision: "2",
    });
    await expect(
      pool.query(
        "UPDATE battle_participant_controller_events SET new_kind='AUTO' WHERE participant_id=$1",
        [wild],
      ),
    ).rejects.toThrow("append-only");
    await expect(
      pool.query("DELETE FROM battle_participant_controller_events WHERE participant_id=$1", [
        wild,
      ]),
    ).rejects.toThrow("append-only");
  });

  it.each(["LOCKED", "COMMITTED", "CANCELLED"])("rejects swaps in %s windows", async (status) => {
    await pool.query(
      `UPDATE battle_turn_windows SET status=$2,
      locked_at=CASE WHEN $2 IN ('LOCKED','COMMITTED') THEN now() ELSE NULL END,
      committed_at=CASE WHEN $2='COMMITTED' THEN now() ELSE NULL END,
      resolution_correlation_id=CASE WHEN $2='COMMITTED' THEN $3::uuid ELSE NULL END,
      resolved_battle_version=CASE WHEN $2='COMMITTED' THEN 7 ELSE NULL END WHERE id=$1`,
      [windowId, status, randomUUID()],
    );
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toBeNull();
    expect(await repository.get(wild)).toMatchObject({ kind: "AUTO", revision: 2 });
  });

  it("rejects old collecting windows and invalid identities without events", async () => {
    await pool.query(
      `UPDATE battle_turn_windows SET status='COLLECTING',locked_at=NULL WHERE id=$1`,
      [windowId],
    );
    await pool.query("UPDATE battles SET version=8 WHERE id=$1", [fixture.battleId]);
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toBeNull();
    await pool.query("UPDATE battles SET version=7 WHERE id=$1", [fixture.battleId]);
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: null,
      }),
    ).toBeNull();
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: -1,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toBeNull();
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).toBeNull();
    expect(await repository.get(wild)).toMatchObject({ revision: 2 });
  });

  it("rejects conflicting initialization and rolls back a failed transition", async () => {
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    await expect(
      repository.initialize({
        participantId: wild,
        battleId: fixture.battleId,
        kind: "NARRATOR",
        playerId: null,
        adminPrincipalId: narrator,
      }),
    ).rejects.toThrow("original identity");
    await expect(
      repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await repository.get(wild)).toMatchObject({ kind: "AUTO", revision: 2 });
    const events = await pool.query(
      "SELECT count(*) FROM battle_participant_controller_events WHERE participant_id=$1",
      [wild],
    );
    expect(events.rows[0].count).toBe("3");
  });

  it("waits for concurrent window closure and rejects the swap after reload", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE battle_turn_windows SET status='LOCKED',locked_at=now() WHERE id=$1",
        [windowId],
      );
      const repository = new PostgresBattleParticipantControllerRepository(pool);
      const pending = repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      });
      await client.query("COMMIT");
      expect(await pending).toBeNull();
      expect(await repository.get(wild)).toMatchObject({ revision: 2 });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rejects controller changes once its action is submitted in a collecting window", async () => {
    await pool.query(
      "UPDATE battle_turn_windows SET status='COLLECTING',locked_at=NULL WHERE id=$1",
      [windowId],
    );
    await pool.query(
      "INSERT INTO battle_turn_window_required_players(turn_window_id,player_id,side_no) VALUES ($1,$2,1)",
      [windowId, fixture.playerA],
    );
    await pool.query(
      `INSERT INTO battle_turn_submissions(id,turn_window_id,player_id,side_no,actor_participant_id,
      expected_battle_version,idempotency_key,action_type,action_payload,submission_revision,status,submitted_at)
      VALUES ($1,$2,$3,1,$4,7,$5,'FLEE','{}',1,'ACTIVE',now())`,
      [randomUUID(), windowId, fixture.playerA, wild, randomUUID()],
    );
    const repository = new PostgresBattleParticipantControllerRepository(pool);
    expect(
      await repository.transition({
        participantId: wild,
        expectedRevision: 2,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toBeNull();
    expect(await repository.get(wild)).toMatchObject({ revision: 2 });
  });

  it("persists controller requirements, narrator actions and partial reload without legacy player identity", async () => {
    const version = 20;
    const npc = randomUUID();
    const state = {
      ...battleState(),
      battleId: fixture.battleId,
      version,
      turnNumber: 4,
      sides: [
        {
          sideNo: 1,
          controllerKind: "PLAYER",
          playerId: fixture.playerA,
          participantIds: [fixture.actorA],
          activeParticipantId: fixture.actorA,
          result: null,
        },
        {
          sideNo: 2,
          controllerKind: "WILD",
          playerId: null,
          participantIds: [npc],
          activeParticipantId: npc,
          result: null,
        },
      ],
      combatants: [
        { ...playerCombatant(), participantId: fixture.actorA },
        { ...wildCombatant(), participantId: npc },
      ],
    };
    await pool.query(
      "INSERT INTO battle_state_snapshots(battle_id,version,schema_version,state) VALUES ($1,$2,1,$3::jsonb)",
      [fixture.battleId, version, JSON.stringify(state)],
    );
    await pool.query(
      `INSERT INTO battle_participants(id,battle_id,battle_side_id,participant_kind,roster_position,snapshot)
      SELECT $1,battle_id,battle_side_id,'WILD_POKEMON',3,'{}' FROM battle_participants WHERE id=$2`,
      [npc, fixture.actorB],
    );
    await new PostgresBattleParticipantControllerRepository(pool).initialize({
      participantId: npc,
      battleId: fixture.battleId,
      kind: "NARRATOR",
      playerId: null,
      adminPrincipalId: narrator,
    });
    const repository = new PostgresBattleTurnWindowRepository(pool);
    const input = {
      id: randomUUID(),
      battleId: fixture.battleId,
      battleVersion: version,
      turnNumber: 4,
      openedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60000),
      requiredPlayers: [],
      requiredControllers: [
        {
          participantId: fixture.actorA,
          kind: "PLAYER" as const,
          playerId: fixture.playerA,
          adminPrincipalId: null,
          sideNo: 1,
          revision: 0,
        },
        {
          participantId: npc,
          kind: "NARRATOR" as const,
          playerId: null,
          adminPrincipalId: narrator,
          sideNo: 2,
          revision: 0,
        },
      ],
    };
    const opened = await repository.open(input);
    if (!opened.ok) throw opened.error;
    await pool.query("UPDATE battles SET version=$2 WHERE id=$1", [fixture.battleId, version]);
    const controllers = new PostgresBattleParticipantControllerRepository(pool);
    expect(
      await controllers.transition({
        participantId: npc,
        expectedRevision: 0,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).toMatchObject({ revision: 1 });
    const automatic = await repository.loadByBattleVersion(fixture.battleId, version);
    if (!automatic.ok) throw automatic.error;
    expect(automatic.value.window.requiredControllers).toHaveLength(1);
    expect(await repository.open(input)).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        aggregate: { window: { requiredControllers: [input.requiredControllers[0]] } },
      },
    });
    expect(
      await controllers.transition({
        participantId: npc,
        expectedRevision: 1,
        kind: "NARRATOR",
        adminPrincipalId: narrator,
      }),
    ).toMatchObject({ revision: 2 });
    const action = {
      id: randomUUID(),
      playerId: null,
      adminPrincipalId: narrator,
      controllerRevision: 2,
      sideNo: 2,
      expectedBattleVersion: version,
      idempotencyKey: randomUUID(),
      action: { type: "FLEE" as const, actorParticipantId: npc },
      submittedAt: new Date(),
    };
    expect((await repository.submit(input.id, { ...action, controllerRevision: 0 })).ok).toBe(
      false,
    );
    expect(await repository.submit(input.id, action)).toMatchObject({ ok: true });
    const restarted = new PostgresBattleTurnWindowRepository(pool);
    const loaded = await restarted.loadByBattleVersion(fixture.battleId, version);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.window.requiredControllers).toEqual(
      input.requiredControllers.map((r) => (r.participantId === npc ? { ...r, revision: 2 } : r)),
    );
    expect(loaded.value.window.status).toBe("COLLECTING");
    expect(loaded.value.submissions[0]).toMatchObject({
      playerId: null,
      adminPrincipalId: narrator,
      controllerRevision: 2,
    });
    expect(
      await controllers.transition({
        participantId: npc,
        expectedRevision: 2,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).toBeNull();
    expect(
      await restarted.submit(input.id, {
        ...action,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await restarted.submit(input.id, {
        ...action,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId: fixture.playerA,
        adminPrincipalId: null,
        controllerRevision: 0,
        sideNo: 1,
        action: { type: "FLEE", actorParticipantId: fixture.actorA },
      }),
    ).toMatchObject({ ok: true, value: { aggregate: { window: { status: "LOCKED" } } } });
    expect(await restarted.submit(input.id, action)).toMatchObject({
      ok: true,
      value: { replayed: true },
    });

    await pool.query(
      "INSERT INTO battle_state_snapshots(battle_id,version,schema_version,state) VALUES ($1,21,1,$2::jsonb)",
      [fixture.battleId, JSON.stringify({ ...state, version: 21 })],
    );
    await pool.query("UPDATE battles SET version=21 WHERE id=$1", [fixture.battleId]);
    const nextInput = {
      ...input,
      id: randomUUID(),
      battleVersion: 21,
      requiredControllers: input.requiredControllers.map((r) =>
        r.participantId === npc ? { ...r, revision: 2 } : r,
      ),
    };
    expect(
      await repository.open({
        ...nextInput,
        requiredControllers: nextInput.requiredControllers.map((r) => ({ ...r, sideNo: 2 })),
      }),
    ).toMatchObject({ ok: false });
    const next = await repository.open(nextInput);
    if (!next.ok) throw next.error;
    const playerAction = {
      ...action,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedBattleVersion: 21,
      sideNo: 1,
      playerId: fixture.playerA,
      adminPrincipalId: null,
      controllerRevision: 0,
      action: { type: "FLEE" as const, actorParticipantId: fixture.actorA },
    };
    await pool.query("UPDATE battles SET version=22 WHERE id=$1", [fixture.battleId]);
    expect(await repository.submit(nextInput.id, playerAction)).toMatchObject({
      ok: false,
      error: { code: "TURN_WINDOW_VERSION_CONFLICT" },
    });
    expect(await repository.loadByBattleVersion(fixture.battleId, 21)).toMatchObject({
      ok: true,
      value: { submissions: [], window: { status: "COLLECTING" } },
    });
    await pool.query("UPDATE battles SET version=21 WHERE id=$1", [fixture.battleId]);
    expect(
      await repository.submit(nextInput.id, {
        ...action,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedBattleVersion: 21,
        sideNo: 1,
        playerId: fixture.playerA,
        adminPrincipalId: null,
        controllerRevision: 0,
        action: { type: "FLEE", actorParticipantId: fixture.actorA },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await controllers.transition({
        participantId: npc,
        expectedRevision: 2,
        kind: "AUTO",
        adminPrincipalId: null,
      }),
    ).toMatchObject({ revision: 3 });
    expect(await repository.loadByBattleVersion(fixture.battleId, 21)).toMatchObject({
      ok: true,
      value: { window: { status: "LOCKED", requiredControllers: [input.requiredControllers[0]] } },
    });
  });

  it.each([1, 2])(
    "persists a %i-player PVE window with one real side and reloads partial submissions",
    async (count) => {
      const version = 9 + count;
      await pool.query(
        "INSERT INTO battle_state_snapshots(battle_id,version,schema_version,state) VALUES ($1,$2,1,'{}')",
        [fixture.battleId, version],
      );
      const repository = new PostgresBattleTurnWindowRepository(pool);
      const opened = await repository.open({
        id: randomUUID(),
        battleId: fixture.battleId,
        battleVersion: version,
        turnNumber: 4,
        openedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60000),
        requiredPlayers: [
          { playerId: fixture.playerA, sideNo: 1 },
          { playerId: fixture.playerB, sideNo: 1 },
        ].slice(0, count),
      });
      if (!opened.ok) throw opened.error;
      const submission = {
        id: randomUUID(),
        playerId: fixture.playerA,
        sideNo: 1,
        expectedBattleVersion: version,
        idempotencyKey: randomUUID(),
        action: { type: "FLEE" as const, actorParticipantId: fixture.actorA },
        submittedAt: new Date(),
      };
      const first = await repository.submit(opened.value.aggregate.window.id, submission);
      expect(first.ok).toBe(true);
      const restarted = new PostgresBattleTurnWindowRepository(pool);
      const partial = await restarted.loadByBattleVersion(fixture.battleId, version);
      if (!partial.ok) throw partial.error;
      expect(partial.value.window.status).toBe(count === 1 ? "LOCKED" : "COLLECTING");
      expect(partial.value.submissions).toHaveLength(1);
      if (count === 2) {
        const replaced = await restarted.submit(partial.value.window.id, {
          ...submission,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
        });
        expect(replaced.ok).toBe(true);
        const completed = await restarted.submit(partial.value.window.id, {
          ...submission,
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          playerId: fixture.playerB,
          action: { type: "FLEE", actorParticipantId: ally },
        });
        expect(completed).toMatchObject({
          ok: true,
          value: {
            aggregate: {
              window: { status: "LOCKED" },
              submissions: expect.arrayContaining([
                expect.objectContaining({ playerId: fixture.playerA, status: "ACTIVE" }),
                expect.objectContaining({ playerId: fixture.playerB, status: "ACTIVE" }),
                expect.objectContaining({ playerId: fixture.playerA, status: "SUPERSEDED" }),
              ]),
            },
          },
        });
      }
      expect(await restarted.submit(partial.value.window.id, submission)).toMatchObject({
        ok: true,
        value: { replayed: true },
      });
    },
  );
});
