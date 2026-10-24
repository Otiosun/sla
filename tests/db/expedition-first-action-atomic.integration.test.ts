import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import {
  PostgresExpeditionFirstAction,
  type FirstActionEffect,
  type FirstActionInput,
} from "../../src/platform/exploration/postgres-expedition-first-action.js";
import { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import { canonicalWorldTravelEffect } from "../../src/platform/exploration/canonical-world-travel-effect.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";
import { appError, err, ok } from "../../src/shared-kernel/result.js";

const enabled =
  process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1" &&
  typeof process.env.POSTGRES_INTEGRATION_TEST_URL === "string";

describe.skipIf(!enabled)("first expedition action: shared atomic PostgreSQL transaction", () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresExpeditionRepository;
  let action: PostgresExpeditionFirstAction;
  let databaseName: string;

  const releaseId = randomUUID();
  const rulesetId = randomUUID();
  const regionId = randomUUID();
  const areaId = randomUUID();
  const yunId = randomUUID();
  const connectionId = randomUUID();
  const reverseConnectionId = randomUUID();
  const speciesId = randomUUID();
  const formId = randomUUID();
  const timestamp = new Date("2026-10-19T12:00:00Z");

  function urlFor(name: string): string {
    const url = new URL(process.env.POSTGRES_INTEGRATION_TEST_URL ?? "");
    url.pathname = `/${name}`;
    url.search = "";
    return url.toString();
  }

  async function seedPublishedWorld(): Promise<void> {
    const typeId = randomUUID();
    const tableId = randomUUID();
    const tableRevisionId = randomUUID();
    await pool.query(
      "INSERT INTO rulesets(id,key,version,engine_contract_version,config,status) VALUES($1,$2,1,1,'{}'::jsonb,'DRAFT')",
      [rulesetId, `atomic-exploration-${rulesetId}`],
    );
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES($1,941001,'Atomic exploration proof','DRAFT',$2)",
      [releaseId, rulesetId],
    );
    await pool.query("INSERT INTO regions(id,slug) VALUES($1,'zhoulia')", [regionId]);
    await pool.query(
      "INSERT INTO region_revisions(id,content_release_id,region_id,display_name,active) VALUES($1,$2,$3,'Zhoulia',TRUE)",
      [randomUUID(), releaseId, regionId],
    );
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES($1,$2,'vila-dos-arrozais')", [
      areaId,
      regionId,
    ]);
    await pool.query(
      `INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active,data)
       VALUES($1,$2,$3,'Vila dos Arrozais',TRUE,$4::jsonb)`,
      [
        randomUUID(),
        releaseId,
        areaId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "TOWN",
          safePoint: true,
          startingArea: true,
          relocationPriority: 0,
        }),
      ],
    );
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES($1,$2,'campos-de-yun')", [
      yunId,
      regionId,
    ]);
    await pool.query(
      `INSERT INTO area_revisions(id,content_release_id,area_id,display_name,active,data)
       VALUES($1,$2,$3,'Campos de Yun',TRUE,$4::jsonb)`,
      [
        randomUUID(),
        releaseId,
        yunId,
        JSON.stringify({
          schemaVersion: 1,
          kind: "ROUTE",
          safePoint: false,
          startingArea: false,
          relocationPriority: 100,
        }),
      ],
    );
    await pool.query(
      "INSERT INTO area_connections(id,from_area_id,to_area_id,connection_key) VALUES($1,$2,$3,'vila-to-yun')",
      [connectionId, areaId, yunId],
    );
    await pool.query(
      `INSERT INTO area_connection_revisions(id,content_release_id,connection_id,active,access_rule)
       VALUES($1,$2,$3,TRUE,$4::jsonb)`,
      [
        randomUUID(),
        releaseId,
        connectionId,
        // Synthetic fixture value only: not the actual reviewed Vila/Yun cost.
        JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], explorationMinutes: 30 }),
      ],
    );
    await pool.query(
      "INSERT INTO area_connections(id,from_area_id,to_area_id,connection_key) VALUES($1,$2,$3,'yun-to-vila')",
      [reverseConnectionId, yunId, areaId],
    );
    await pool.query(
      `INSERT INTO area_connection_revisions(id,content_release_id,connection_id,active,access_rule)
       VALUES($1,$2,$3,TRUE,$4::jsonb)`,
      [
        randomUUID(),
        releaseId,
        reverseConnectionId,
        // Real-time cooldown is not an expedition-duration policy.
        JSON.stringify({ schemaVersion: 1, requiredUnlockKeys: [], travelSeconds: 180 }),
      ],
    );
    await pool.query("INSERT INTO pokemon_types(id,slug) VALUES($1,'normal')", [typeId]);
    await pool.query(
      "INSERT INTO pokemon_species(id,national_dex,slug) VALUES($1,986,'atomic-test-species')",
      [speciesId],
    );
    await pool.query("INSERT INTO pokemon_forms(id,species_id,slug) VALUES($1,$2,'default')", [
      formId,
      speciesId,
    ]);
    await pool.query(
      "INSERT INTO pokemon_species_revisions(id,content_release_id,species_id,display_name,active) VALUES($1,$2,$3,'Atomic Species',TRUE)",
      [randomUUID(), releaseId, speciesId],
    );
    await pool.query(
      `INSERT INTO pokemon_form_revisions(
        id,content_release_id,form_id,display_name,type1_id,
        base_hp,base_attack,base_defense,base_sp_attack,base_sp_defense,base_speed,active
      ) VALUES($1,$2,$3,'Atomic Form',$4,40,40,40,40,40,40,TRUE)`,
      [randomUUID(), releaseId, formId, typeId],
    );
    await pool.query(
      "INSERT INTO encounter_tables(id,area_id,slug) VALUES($1,$2,'atomic-encounters')",
      [tableId, areaId],
    );
    await pool.query(
      "INSERT INTO encounter_table_revisions(id,content_release_id,encounter_table_id,active) VALUES($1,$2,$3,TRUE)",
      [tableRevisionId, releaseId, tableId],
    );
    await pool.query(
      "INSERT INTO encounter_entries(id,encounter_table_revision_id,form_id,weight,min_level,max_level,active) VALUES($1,$2,$3,100,2,5,TRUE)",
      [randomUUID(), tableRevisionId, formId],
    );
    const yunTableId = randomUUID();
    const yunRevisionId = randomUUID();
    await pool.query(
      "INSERT INTO encounter_tables(id,area_id,slug) VALUES($1,$2,'yun-encounters')",
      [yunTableId, yunId],
    );
    await pool.query(
      "INSERT INTO encounter_table_revisions(id,content_release_id,encounter_table_id,active) VALUES($1,$2,$3,TRUE)",
      [yunRevisionId, releaseId, yunTableId],
    );
    await pool.query(
      "INSERT INTO encounter_entries(id,encounter_table_revision_id,form_id,weight,min_level,max_level,active) VALUES($1,$2,$3,100,4,8,TRUE)",
      [randomUUID(), yunRevisionId, formId],
    );
    await pool.query(
      "UPDATE rulesets SET status='VALIDATED',validated_at=now(),validation_report='{}'::jsonb,config_fingerprint=$2 WHERE id=$1",
      [rulesetId, "a".repeat(64)],
    );
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [
      rulesetId,
    ]);
    await pool.query(
      "UPDATE content_releases SET status='VALIDATED',validated_at=now(),validation_report='{}'::jsonb,content_fingerprint=$2 WHERE id=$1",
      [releaseId, "b".repeat(64)],
    );
    await pool.query(
      "UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1",
      [releaseId],
    );
    await pool.query(
      "INSERT INTO content_release_pointers(pointer_key,content_release_id) VALUES('ACTIVE',$1)",
      [releaseId],
    );
  }

  async function prepared(
    key: string,
    startAreaId = areaId,
  ): Promise<{
    playerId: PlayerId;
    expeditionId: string;
  }> {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id,status) VALUES($1,'ACTIVE')", [playerId]);
    await pool.query(
      "INSERT INTO onboarding_states(player_id,state,starter_claim_key,completed_at) VALUES($1,'COMPLETE',$2,now())",
      [playerId, `test-claim-${playerId}`],
    );
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES($1,$2)", [
      playerId,
      startAreaId,
    ]);
    const start = await store.prepare({ playerId, period: "DAY", idempotencyKey: key });
    if (!start.ok) throw start.error;
    return { playerId, expeditionId: start.value.expedition.expeditionId };
  }

  async function proofCount(playerId: PlayerId): Promise<number> {
    const row = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM atomic_exploration_test_effects WHERE player_id=$1",
      [playerId],
    );
    return row.rows[0]?.count ?? 0;
  }

  function proofEffect(): FirstActionEffect {
    return {
      actionKey: "test.atomic-proof",
      actionFingerprint: "c".repeat(64),
      async apply(client: PoolClient, ctx) {
        const id = randomUUID();
        await client.query(
          "INSERT INTO atomic_exploration_test_effects(id,player_id,expedition_id) VALUES($1,$2,$3)",
          [id, ctx.playerId, ctx.expeditionId],
        );
        return ok({ id, areaId: ctx.areaId });
      },
    };
  }

  function input(
    preparedValue: { playerId: PlayerId; expeditionId: string },
    idempotencyKey: string,
    effect: FirstActionEffect = proofEffect(),
  ): FirstActionInput {
    return {
      playerId: preparedValue.playerId,
      expeditionId: preparedValue.expeditionId,
      expectedRevision: 0n,
      expectedLocationRevision: 0n,
      expectedContentReleaseId: releaseId,
      minutes: 30,
      idempotencyKey,
      effect,
    };
  }

  beforeAll(async () => {
    databaseName = `pokemon_atomic_exp_${process.pid}_${Date.now()}`;
    admin = new Pool({ connectionString: urlFor("postgres"), max: 1 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: urlFor(databaseName), max: 6 });
    await runMigrations(pool, { appliedBy: "atomic-expedition-vitest" });
    const sql = await readFile(
      new URL("../../db/drafts/solo_exploration_v1_schema.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(
      "CREATE TABLE atomic_exploration_test_effects(id UUID PRIMARY KEY,player_id UUID NOT NULL,expedition_id UUID NOT NULL)",
    );
    await seedPublishedWorld();
    const clock = new ManualClock(timestamp);
    store = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
    action = new PostgresExpeditionFirstAction(pool, clock, "America/Maceio");
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  it("commits weekly quota, clock, test-only effect and receipt together; replay never reruns effect", async () => {
    const subject = await prepared("happy-prepare");
    const request = input(subject, "inbox-first");
    const first = await action.execute(request);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        consumedWeeklySlot: true,
        expedition: { phase: "ACTIVE", elapsedMinutes: 30, revision: 1n },
      },
    });
    const retry = await action.execute(request);
    expect(retry).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        consumedWeeklySlot: true,
        expedition: { elapsedMinutes: 30, revision: 1n },
      },
    });
    if (first.ok && retry.ok) expect(retry.value.effectResult).toEqual(first.value.effectResult);
    expect(await proofCount(subject.playerId)).toBe(1);
    const receipt = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM solo_expedition_receipts WHERE player_id=$1",
      [subject.playerId],
    );
    expect(receipt.rows[0]?.count).toBe(2);
    expect(await action.execute({ ...request, minutes: 60 })).toMatchObject({
      ok: false,
      error: { code: "FINGERPRINT_MISMATCH" },
    });
  });

  it("rolls back all writes if effect returns a domain failure, then permits a valid retry", async () => {
    const subject = await prepared("domain-prepare");
    const request = input(subject, "domain-first", {
      ...proofEffect(),
      async apply(client, ctx) {
        await client.query(
          "INSERT INTO atomic_exploration_test_effects(id,player_id,expedition_id) VALUES($1,$2,$3)",
          [randomUUID(), ctx.playerId, ctx.expeditionId],
        );
        return err(appError("ACTION_INVALID", "Synthetic action declined"));
      },
    });
    expect(await action.execute(request)).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    expect(await proofCount(subject.playerId)).toBe(0);
    expect(await store.current(subject.playerId)).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
      revision: 0n,
    });
    const valid = await action.execute({ ...request, effect: proofEffect() });
    expect(valid).toMatchObject({ ok: true, value: { consumedWeeklySlot: true } });
    expect(await proofCount(subject.playerId)).toBe(1);
  });

  it("rolls back a thrown PostgreSQL effect error", async () => {
    const subject = await prepared("throw-prepare");
    const request = input(subject, "throw-first", {
      ...proofEffect(),
      async apply(client, ctx) {
        await client.query(
          "INSERT INTO atomic_exploration_test_effects(id,player_id,expedition_id) VALUES($1,$2,$3)",
          [randomUUID(), ctx.playerId, ctx.expeditionId],
        );
        throw new Error("synthetic effect failure");
      },
    });
    await expect(action.execute(request)).rejects.toThrow("synthetic effect failure");
    expect(await proofCount(subject.playerId)).toBe(0);
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
  });

  it("serializes two competing messages: exactly one commits", async () => {
    const subject = await prepared("racing-prepare");
    const results = await Promise.all([
      action.execute(input(subject, "race-a")),
      action.execute(input(subject, "race-b")),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "FLOW_BLOCKED" } },
    ]);
    expect(await proofCount(subject.playerId)).toBe(1);
  });

  it("refuses stale World location or release without applying an effect", async () => {
    const subject = await prepared("world-prepare");
    await pool.query("UPDATE player_locations SET revision=1 WHERE player_id=$1", [
      subject.playerId,
    ]);
    expect(await action.execute(input(subject, "stale-world"))).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(
      await action.execute({
        ...input(subject, "bad-release"),
        expectedContentReleaseId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await proofCount(subject.playerId)).toBe(0);
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
  });

  it("blocks the fourth weekly slot and refuses zero-cost first actions", async () => {
    const subject = await prepared("weekly-prepare");
    for (let index = 0; index < 3; index += 1) {
      await pool.query(
        `INSERT INTO solo_expeditions(
           id,player_id,period,area_id,phase,elapsed_minutes,consumed_week_key,end_reason
         ) VALUES($1,$2,'DAY',$3,'ENDED',30,'2026-10-19','VOLUNTARY')`,
        [randomUUID(), subject.playerId, areaId],
      );
    }
    expect(await action.execute(input(subject, "fourth-slot"))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect(await action.execute({ ...input(subject, "zero-action"), minutes: 0 })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await proofCount(subject.playerId)).toBe(0);
  });
  it("applies real World travel together with the first-action quota, clock and both receipts", async () => {
    const subject = await prepared("world-travel-prepare");
    const request = input(
      subject,
      "world-travel-first",
      canonicalWorldTravelEffect({
        destinationAreaId: yunId,
        expectedLocationRevision: 0n,
        worldFeature: { enabled: true, reason: null },
        clock: new ManualClock(timestamp),
      }),
    );

    // 30 is a synthetic TEST duration, not an approved Vila/Yun route cost.
    const first = await action.execute(request);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        consumedWeeklySlot: true,
        expedition: { phase: "ACTIVE", elapsedMinutes: 30, revision: 1n },
        effectResult: {
          kind: "WORLD_TRAVEL",
          fromAreaId: areaId,
          toAreaId: yunId,
          worldRevision: "1",
          expeditionMinutes: 30,
        },
      },
    });
    const retry = await action.execute(request);
    expect(retry).toMatchObject({
      ok: true,
      value: { replayed: true, effectResult: { toAreaId: yunId } },
    });
    const worldState = await pool.query<{ area_id: string; revision: string }>(
      "SELECT area_id::text,revision::text FROM player_locations WHERE player_id=$1",
      [subject.playerId],
    );
    expect(worldState.rows[0]).toMatchObject({ area_id: yunId, revision: "1" });
    const receipts = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM world_travel_receipts WHERE player_id=$1",
      [subject.playerId],
    );
    expect(receipts.rows[0]?.count).toBe(1);
    const visited = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM player_area_visits WHERE player_id=$1 AND area_id=$2",
      [subject.playerId, yunId],
    );
    expect(visited.rows[0]?.count).toBe(1);
  });

  it("rolls back canonical World movement and World receipt when a later effect fails", async () => {
    const subject = await prepared("world-rollback-prepare");
    const realEffect = canonicalWorldTravelEffect({
      destinationAreaId: yunId,
      expectedLocationRevision: 0n,
      worldFeature: { enabled: true, reason: null },
      clock: new ManualClock(timestamp),
    });
    const failure: FirstActionEffect = {
      ...realEffect,
      async apply(client, ctx) {
        const moved = await realEffect.apply(client, ctx);
        if (!moved.ok) return moved;
        return err(appError("ACTION_INVALID", "Synthetic failure after World travel"));
      },
    };
    expect(await action.execute(input(subject, "world-rollback-first", failure))).toMatchObject({
      ok: false,
      error: { code: "ACTION_INVALID" },
    });
    const location = await pool.query<{ area_id: string; revision: string }>(
      "SELECT area_id::text,revision::text FROM player_locations WHERE player_id=$1",
      [subject.playerId],
    );
    expect(location.rows[0]).toEqual({ area_id: areaId, revision: "0" });
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
    const receipt = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM world_travel_receipts WHERE player_id=$1",
      [subject.playerId],
    );
    expect(receipt.rows[0]?.count).toBe(0);
    const visits = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM player_area_visits WHERE player_id=$1",
      [subject.playerId],
    );
    expect(visits.rows[0]?.count).toBe(0);
  });

  it("refuses a destination that has no published exploration encounters", async () => {
    const subject = await prepared("unpublished-destination-prepare");
    const outside = randomUUID();
    const effect = canonicalWorldTravelEffect({
      destinationAreaId: outside,
      expectedLocationRevision: 0n,
      worldFeature: { enabled: true, reason: null },
      clock: new ManualClock(timestamp),
    });
    expect(await action.execute(input(subject, "outside-destination", effect))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
  });
  it("rejects an arbitrary travel-minute charge even when World would permit the route", async () => {
    const subject = await prepared("mismatched-route-minutes");
    const effect = canonicalWorldTravelEffect({
      destinationAreaId: yunId,
      expectedLocationRevision: 0n,
      worldFeature: { enabled: true, reason: null },
      clock: new ManualClock(timestamp),
    });
    // The published test connection declares 30, not 29 minutes.
    expect(
      await action.execute({ ...input(subject, "wrong-minutes", effect), minutes: 29 }),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
    const world = await pool.query<{ area_id: string }>(
      "SELECT area_id::text FROM player_locations WHERE player_id=$1",
      [subject.playerId],
    );
    expect(world.rows[0]?.area_id).toBe(areaId);
  });

  it("fails closed when connection has only travelSeconds but no explorationMinutes", async () => {
    const subject = await prepared("cooldown-is-not-route-duration", yunId);
    const effect = canonicalWorldTravelEffect({
      destinationAreaId: areaId,
      expectedLocationRevision: 0n,
      worldFeature: { enabled: true, reason: null },
      clock: new ManualClock(timestamp),
    });
    expect(await action.execute(input(subject, "missing-minutes", effect))).toMatchObject({
      ok: false,
      error: { code: "FLOW_BLOCKED" },
    });
    expect((await store.current(subject.playerId))?.phase).toBe("PREPARING");
    const world = await pool.query<{ area_id: string }>(
      "SELECT area_id::text FROM player_locations WHERE player_id=$1",
      [subject.playerId],
    );
    expect(world.rows[0]?.area_id).toBe(yunId);
  });
  it("resumes after canonical travel from World current area, preserving the immutable origin", async () => {
    const subject = await prepared("resume-after-travel");
    const firstRequest = input(
      subject,
      "resume-first",
      canonicalWorldTravelEffect({
        destinationAreaId: yunId,
        expectedLocationRevision: 0n,
        worldFeature: { enabled: true, reason: null },
        clock: new ManualClock(timestamp),
      }),
    );
    expect(await action.execute(firstRequest)).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: true,
        expedition: { areaId, currentAreaId: yunId, revision: 1n },
      },
    });

    const nextRequest: FirstActionInput = {
      ...input(subject, "resume-next", proofEffect()),
      expectedRevision: 1n,
      expectedLocationRevision: 1n,
      minutes: 15,
    };
    const next = await action.executeNext(nextRequest);
    expect(next).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        consumedWeeklySlot: false,
        expedition: {
          areaId,
          currentAreaId: yunId,
          elapsedMinutes: 45,
          phase: "ACTIVE",
          revision: 2n,
        },
      },
    });
    expect(await action.executeNext(nextRequest)).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        consumedWeeklySlot: false,
        expedition: { areaId, currentAreaId: yunId, elapsedMinutes: 45 },
      },
    });
    expect(await proofCount(subject.playerId)).toBe(1);
    expect(await store.current(subject.playerId)).toMatchObject({
      areaId,
      currentAreaId: yunId,
      elapsedMinutes: 45,
      revision: 2n,
    });
    const slots = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key IS NOT NULL",
      [subject.playerId],
    );
    expect(slots.rows[0]?.count).toBe(1);
  });

  it("rejects an out-of-band World move even with a fresh World revision", async () => {
    const subject = await prepared("out-of-band-move");
    const travel = input(
      subject,
      "out-of-band-first",
      canonicalWorldTravelEffect({
        destinationAreaId: yunId,
        expectedLocationRevision: 0n,
        worldFeature: { enabled: true, reason: null },
        clock: new ManualClock(timestamp),
      }),
    );
    expect((await action.execute(travel)).ok).toBe(true);
    await pool.query(
      "UPDATE player_locations SET area_id=$2,revision=revision+1 WHERE player_id=$1",
      [subject.playerId, areaId],
    );
    expect(
      await action.executeNext({
        ...input(subject, "out-of-band-next"),
        expectedRevision: 1n,
        expectedLocationRevision: 2n,
        minutes: 15,
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await proofCount(subject.playerId)).toBe(0);
    expect(await store.current(subject.playerId)).toMatchObject({
      areaId,
      currentAreaId: yunId,
      elapsedMinutes: 30,
      revision: 1n,
    });
  });

  it("rolls back a continuing action error without spending a second slot or losing World cursor", async () => {
    const subject = await prepared("continuing-rollback");
    const first = await action.execute(input(subject, "continuing-first"));
    expect(first.ok).toBe(true);
    const failing: FirstActionEffect = {
      ...proofEffect(),
      async apply(client, ctx) {
        await client.query(
          "INSERT INTO atomic_exploration_test_effects(id,player_id,expedition_id) VALUES($1,$2,$3)",
          [randomUUID(), ctx.playerId, ctx.expeditionId],
        );
        return err(appError("ACTION_INVALID", "Synthetic failure on continuing action"));
      },
    };
    expect(
      await action.executeNext({
        ...input(subject, "continuing-next", failing),
        expectedRevision: 1n,
        minutes: 15,
      }),
    ).toMatchObject({ ok: false, error: { code: "ACTION_INVALID" } });
    expect(await proofCount(subject.playerId)).toBe(1);
    expect(await store.current(subject.playerId)).toMatchObject({
      areaId,
      currentAreaId: areaId,
      elapsedMinutes: 30,
      revision: 1n,
    });
  });

  it("serializes competing continuing actions after travel: only one can commit", async () => {
    const subject = await prepared("continuing-race");
    expect((await action.execute(input(subject, "continuing-race-first"))).ok).toBe(true);
    const a: FirstActionInput = {
      ...input(subject, "continuing-race-a"),
      expectedRevision: 1n,
      minutes: 15,
    };
    const b: FirstActionInput = { ...a, idempotencyKey: "continuing-race-b" };
    const results = await Promise.all([action.executeNext(a), action.executeNext(b)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await proofCount(subject.playerId)).toBe(2);
    expect(await store.current(subject.playerId)).toMatchObject({
      elapsedMinutes: 45,
      revision: 2n,
    });
  });

});
