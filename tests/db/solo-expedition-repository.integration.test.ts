import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const dbName = "pokemon_solo_expedition_" + process.pid + "_" + Date.now();

function databaseUrlFor(db: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/" + db;
  return url.toString();
}

describe.sequential("solo expedition lifecycle in an isolated PostgreSQL database", () => {
  let adminPool: Pool;
  let pool: Pool;
  let clock: ManualClock;
  let store: PostgresExpeditionRepository;

  async function trainer(): Promise<PlayerId> {
    const id = createPlayerId();
    const region = randomUUID();
    const area = randomUUID();
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [id]);
    await pool.query("INSERT INTO regions(id,slug) VALUES ($1,$2)", [
      region, "solo-region-" + region,
    ]);
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,$3)", [
      area,region,"solo-area-" + area,
    ]);
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [id,area]);
    return id;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query('CREATE DATABASE "' + dbName + '"');
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "solo-exploration-draft-vitest" });
    const sql = await readFile(
      new URL("../../db/drafts/solo_exploration_v1_schema.sql", import.meta.url), "utf8",
    );
    await pool.query(sql);
    clock = new ManualClock(new Date("2026-10-19T12:00:00Z"));
    store = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)');
      await adminPool.end();
    }
  });

  it("stores a free preparation, preserves location, and resumes after adapter reconstruction", async () => {
    const playerId = await trainer();
    const prepared = await store.prepare({ playerId, period: "DAY", idempotencyKey: "prepare-one" });
    expect(prepared).toMatchObject({
      ok: true,
      value: { consumedWeeklySlot: false, replayed: false, expedition: {
        phase: "PREPARING", elapsedMinutes: 0, consumedWeekKey: null,
      } },
    });
    expect(await store.current(playerId)).toMatchObject({ phase: "PREPARING", revision: 0n });
    const restored = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
    const fromRestart = await restored.current(playerId);
    expect(fromRestart?.expeditionId).toBe(prepared.ok ? prepared.value.expedition.expeditionId : null);
    expect(fromRestart?.areaId).toBe(prepared.ok ? prepared.value.expedition.areaId : null);
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key IS NOT NULL",
      [playerId],
    )).rows[0].n).toBe(0);
  });

  it("consumes the weekly slot once, survives repeat messages and verifies fingerprint binding", async () => {
    const playerId = await trainer();
    const prepared = await store.prepare({ playerId, period: "NIGHT", idempotencyKey: "prep-2" });
    if (!prepared.ok) throw prepared.error;
    const expeditionId = prepared.value.expedition.expeditionId;
    const input = { playerId, expeditionId, expectedRevision: 0n, minutes: 30, idempotencyKey: "action-2" };
    const first = await store.advance(input);
    expect(first).toMatchObject({
      ok: true, value: { replayed: false, consumedWeeklySlot: true, expedition: {
        elapsedMinutes: 30, revision: 1n, consumedWeekKey: "2026-10-19",
      } },
    });
    expect(await store.advance(input)).toMatchObject({
      ok: true, value: { replayed: true, consumedWeeklySlot: true,
        expedition: { elapsedMinutes: 30, revision: 1n } },
    });
    expect(await store.advance({ ...input, minutes: 60 })).toMatchObject({
      ok: false, error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    expect(await store.prepare({ playerId, period: "NIGHT", idempotencyKey: "prep-2" })).toMatchObject({
      ok: true, value: { replayed: true, expedition: { phase: "PREPARING", revision: 0n } },
    });
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM solo_expedition_receipts WHERE player_id=$1",
      [playerId],
    )).rows[0].n).toBe(2);
  });

  it("serializes simultaneous unique commands and does not charge duplicate first actions", async () => {
    const playerId = await trainer();
    const prepared = await store.prepare({ playerId, period: "DAY", idempotencyKey: "prep-concur" });
    if (!prepared.ok) throw prepared.error;
    const expeditionId = prepared.value.expedition.expeditionId;
    const args = { playerId, expeditionId, expectedRevision: 0n, minutes: 30 };
    const [left,right] = await Promise.all([
      store.advance({ ...args, idempotencyKey: "concur-a" }),
      store.advance({ ...args, idempotencyKey: "concur-b" }),
    ]);
    expect([left,right].filter(x => x.ok)).toHaveLength(1);
    expect([left,right].filter(x => !x.ok)).toMatchObject([{
      ok: false, error: { code: "REVISION_CONFLICT" },
    }]);
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM solo_expeditions WHERE player_id=$1 AND consumed_week_key='2026-10-19'",
      [playerId],
    )).rows[0].n).toBe(1);
    expect((await store.current(playerId))?.elapsedMinutes).toBe(30);
  });

  it("deduplicates concurrent delivery of the same WhatsApp idempotency key", async () => {
    const playerId = await trainer();
    const prepared = await store.prepare({ playerId, period: "DAY", idempotencyKey: "prep-dupe" });
    if (!prepared.ok) throw prepared.error;
    const args = {
      playerId, expeditionId: prepared.value.expedition.expeditionId,
      expectedRevision: 0n, minutes: 30, idempotencyKey: "same-inbox-key",
    };
    const responses = await Promise.all([store.advance(args),store.advance(args)]);
    expect(responses.every(x => x.ok)).toBe(true);
    expect(responses.filter(x => x.ok && x.value.replayed)).toHaveLength(1);
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM solo_expedition_receipts WHERE player_id=$1 AND idempotency_key=$2",
      [playerId,args.idempotencyKey],
    )).rows[0].n).toBe(1);
  });

  it("prevents the fourth expedition and resets precisely on local Monday", async () => {
    const playerId = await trainer();
    for (let i=0; i<3; i+=1) {
      const prepared=await store.prepare({playerId,period:"DAY",idempotencyKey:"week-prep-"+i});
      if (!prepared.ok) throw prepared.error;
      const expeditionId=prepared.value.expedition.expeditionId;
      const advanced=await store.advance({
        playerId,expeditionId,expectedRevision:0n,minutes:30,idempotencyKey:"week-action-"+i,
      });
      expect(advanced.ok).toBe(true);
      const ended=await store.end({
        playerId,expeditionId,expectedRevision:1n,reason:"VOLUNTARY",
        idempotencyKey:"week-end-"+i,
      });
      expect(ended).toMatchObject({ok:true,value:{expedition:{phase:"ENDED",endReason:"VOLUNTARY"}}});
    }
    expect(await store.prepare({
      playerId,period:"DAY",idempotencyKey:"week-fourth",
    })).toMatchObject({ok:false,error:{code:"FLOW_BLOCKED"}});
    // 2026-10-19 Monday 09:00 Maceio => following Monday 00:00.
    clock.advanceMs(6*24*60*60*1000 + 15*60*60*1000);
    const next=await store.prepare({
      playerId,period:"NIGHT",idempotencyKey:"next-week-prep",
    });
    expect(next).toMatchObject({ok:true,value:{expedition:{phase:"PREPARING"}}});
  });

  it("allows continuing an existing active expedition after calendar reset without a second debit", async () => {
    const playerId=await trainer();
    const prepared=await store.prepare({playerId,period:"DAY",idempotencyKey:"resume-prep"});
    if(!prepared.ok) throw prepared.error;
    const expeditionId=prepared.value.expedition.expeditionId;
    const a=await store.advance({
      playerId,expeditionId,expectedRevision:0n,minutes:30,idempotencyKey:"resume-a",
    });
    expect(a.ok).toBe(true);
    clock.advanceMs(7*24*60*60*1000);
    const b=await store.advance({
      playerId,expeditionId,expectedRevision:1n,minutes:15,idempotencyKey:"resume-b",
    });
    expect(b).toMatchObject({ok:true,value:{
      consumedWeeklySlot:false,expedition:{consumedWeekKey:"2026-10-26",elapsedMinutes:45},
    }});
  });

  it("cancels free preparation and preserves stored blackout without payout receipt", async () => {
    const playerId=await trainer();
    const prepared=await store.prepare({playerId,period:"NIGHT",idempotencyKey:"cancel-prep"});
    if(!prepared.ok) throw prepared.error;
    const expeditionId=prepared.value.expedition.expeditionId;
    const cancelled=await store.end({
      playerId,expeditionId,expectedRevision:0n,reason:"CANCELLED",idempotencyKey:"cancel-action",
    });
    expect(cancelled).toMatchObject({ok:true,value:{expedition:{endReason:"CANCELLED",consumedWeekKey:null}}});
    expect(await store.current(playerId)).toBeNull();
    const restart=await store.prepare({playerId,period:"DAY",idempotencyKey:"blackout-prep"});
    if(!restart.ok) throw restart.error;
    const activeId=restart.value.expedition.expeditionId;
    expect((await store.advance({
      playerId,expeditionId:activeId,expectedRevision:0n,minutes:60,
      idempotencyKey:"blackout-start",
    })).ok).toBe(true);
    expect(await store.end({
      playerId,expeditionId:activeId,expectedRevision:1n,reason:"BLACKOUT",
      idempotencyKey:"blackout",
    })).toMatchObject({ok:true,value:{expedition:{phase:"ENDED",endReason:"BLACKOUT"}}});
  });

  it("rejects bad action length and stale revisions without storing receipts", async () => {
    const playerId=await trainer();
    const prepared=await store.prepare({playerId,period:"DAY",idempotencyKey:"invalid-prep"});
    if(!prepared.ok) throw prepared.error;
    const expeditionId=prepared.value.expedition.expeditionId;
    expect(await store.advance({
      playerId,expeditionId,expectedRevision:0n,minutes:721,idempotencyKey:"invalid-time",
    })).toMatchObject({ok:false,error:{code:"VALIDATION_FAILED"}});
    expect(await store.advance({
      playerId,expeditionId,expectedRevision:8n,minutes:30,idempotencyKey:"stale",
    })).toMatchObject({ok:false,error:{code:"REVISION_CONFLICT"}});
    expect((await pool.query(
      "SELECT count(*)::int AS n FROM solo_expedition_receipts WHERE player_id=$1",
      [playerId],
    )).rows[0].n).toBe(1);
    expect((await store.current(playerId))?.revision).toBe(0n);
  });
});
