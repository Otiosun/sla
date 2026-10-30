import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresExpeditionRepository } from "../../src/platform/exploration/postgres-expedition-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

const dbName = "pokemon_solo_exp_" + process.pid + "_" + Date.now();

function databaseUrlFor(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = "/" + name;
  return url.toString();
}

describe.sequential("solo expedition PostgreSQL draft persistence", () => {
  let adminPool: Pool;
  let pool: Pool;
  let clock: ManualClock;
  let store: PostgresExpeditionRepository;
  let publishedReleaseId: string;

  async function trainer(): Promise<PlayerId> {
    const id = createPlayerId();
    const region = randomUUID();
    const area = randomUUID();
    await pool.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [id]);
    await pool.query("INSERT INTO regions(id,slug) VALUES ($1,$2)", [
      region,
      "solo-region-" + region,
    ]);
    await pool.query("INSERT INTO areas(id,region_id,slug) VALUES ($1,$2,$3)", [
      area,
      region,
      "solo-area-" + area,
    ]);
    await pool.query(
      "INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data) VALUES ($1,$2,$3,$4,TRUE,'{}'::jsonb)",
      [randomUUID(), publishedReleaseId, region, "Solo Region " + region],
    );
    await pool.query(
      "INSERT INTO area_revisions(id, content_release_id, area_id, display_name, active, data) VALUES ($1,$2,$3,$4,TRUE,$5::jsonb)",
      [randomUUID(), publishedReleaseId, area, "Solo Area " + area,
        JSON.stringify({ schemaVersion: 1, kind: "ROUTE", safePoint: false, startingArea: false, relocationPriority: 10 })],
    );
    await pool.query("INSERT INTO player_locations(player_id,area_id) VALUES ($1,$2)", [id, area]);
    return id;
  }

  async function prepare(playerId: PlayerId, key: string) {
    const result = await store.prepare({
      playerId,
      period: "DAY",
      idempotencyKey: key,
    });
    if (!result.ok) throw result.error;
    return result.value.expedition;
  }

  async function count(
    table: "solo_expeditions" | "solo_expedition_receipts",
    playerId: PlayerId,
  ): Promise<number> {
    const sql = "SELECT count(*)::int AS n FROM " + table + " WHERE player_id=$1";
    const result = await pool.query<{ n: number }>(sql, [playerId]);
    return result.rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query('CREATE DATABASE "' + dbName + '"');
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "solo-exploration-draft-vitest" });
    const sql = await readFile(
      new URL("../../db/drafts/solo_exploration_v1_schema.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    const rulesetId = randomUUID();
    publishedReleaseId = randomUUID();
    await pool.query(
      "INSERT INTO rulesets(id,key,version,engine_contract_version,config,status) VALUES ($1,'solo-expedition-proof',1,1,'{}'::jsonb,'DRAFT')",
      [rulesetId],
    );
    await pool.query(
      "UPDATE rulesets SET status='VALIDATED',validated_at=now(),validation_report=$2::jsonb,config_fingerprint=$3 WHERE id=$1",
      [rulesetId, JSON.stringify({valid:true, issues:[]}), "a".repeat(64)],
    );
    await pool.query("UPDATE rulesets SET status='PUBLISHED',published_at=now() WHERE id=$1", [rulesetId]);
    await pool.query(
      "INSERT INTO content_releases(id,release_no,name,status,default_ruleset_id) VALUES ($1,999993,'Solo Expedition Draft UAT','DRAFT',$2)",
      [publishedReleaseId, rulesetId],
    );
    await pool.query(
      "UPDATE content_releases SET status='VALIDATED',validated_at=now(),validation_report=$2::jsonb,content_fingerprint=$3 WHERE id=$1",
      [publishedReleaseId, JSON.stringify({valid:true,issues:[]}), "b".repeat(64)],
    );
    await pool.query(
      "UPDATE content_releases SET status='PUBLISHED',published_at=now() WHERE id=$1",
      [publishedReleaseId],
    );
    await pool.query(
      "INSERT INTO content_release_pointers(pointer_key,content_release_id) VALUES ('ACTIVE',$1)",
      [publishedReleaseId],
    );
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

  it("fails closed if the current area was removed from the ACTIVE PUBLISHED release", async () => {
    const playerId = await trainer();
    await pool.query(
      "UPDATE area_revisions SET active=FALSE WHERE content_release_id=$1 AND area_id=(SELECT area_id FROM player_locations WHERE player_id=$2)",
      [publishedReleaseId, playerId],
    );
    const blocked = await store.prepare({
      playerId, period: "DAY", idempotencyKey: "unpublished-area",
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
    expect(await count("solo_expedition_receipts", playerId)).toBe(0);
  });

  it("fails closed if the entire region is inactive in the published release", async () => {
    const playerId = await trainer();
    await pool.query(
      "UPDATE region_revisions SET active=FALSE WHERE content_release_id=$1 AND region_id=(SELECT area.region_id FROM player_locations location JOIN areas area ON area.id=location.area_id WHERE location.player_id=$2)",
      [publishedReleaseId, playerId],
    );
    expect(await store.prepare({
      playerId, period: "NIGHT", idempotencyKey: "unpublished-region",
    })).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    expect(await count("solo_expeditions", playerId)).toBe(0);
  });

  it("persists free preparation and restores its location after reconstruction", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "init");
    expect(initial).toMatchObject({
      phase: "PREPARING",
      elapsedMinutes: 0,
      consumedWeekKey: null,
      revision: 0n,
    });
    const reloaded = new PostgresExpeditionRepository(pool, clock, "America/Maceio");
    expect(await reloaded.current(playerId)).toEqual(initial);
    expect(await count("solo_expeditions", playerId)).toBe(1);
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
  });

  it("persists a free NIGHT switch, replays one receipt and charges no quota", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "period-prepare");
    const input = {
      playerId, expeditionId: expedition.expeditionId,
      expectedRevision: 0n, period: "NIGHT" as const,
      idempotencyKey: "period-one",
    };
    const switched = await store.changePeriod(input);
    expect(switched).toMatchObject({
      ok: true, value: { changed: true, replayed: false, consumedWeeklySlot: false,
        expedition: { period: "NIGHT", phase: "PREPARING",
          elapsedMinutes: 0, consumedWeekKey: null, revision: 1n } },
    });
    expect((await store.current(playerId))?.period).toBe("NIGHT");
    expect(await store.changePeriod(input)).toMatchObject({
      ok: true, value: { replayed: true, expedition: { revision: 1n, period: "NIGHT" } },
    });
    expect(await store.changePeriod({ ...input, period: "DAY" })).toMatchObject({
      ok: false, error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    expect(await store.changePeriod({ ...input, idempotencyKey: "period-stale" })).toMatchObject({
      ok: false, error: { code: "REVISION_CONFLICT" },
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
    const started = await store.advance({
      playerId, expeditionId: expedition.expeditionId,
      expectedRevision: 1n, minutes: 30, idempotencyKey: "period-start",
    });
    expect(started).toMatchObject({
      ok: true, value: { consumedWeeklySlot: true,
        expedition: { phase: "ACTIVE", period: "NIGHT" } },
    });
    expect(await store.changePeriod({
      ...input, expectedRevision: 2n, idempotencyKey: "period-too-late",
      period: "DAY",
    })).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
  });

  it("serializes two racing period changes and deduplicates a retry", async () => {
    const playerId = await trainer();
    const expedition = await prepare(playerId, "race-period-prepare");
    const base = {
      playerId, expeditionId: expedition.expeditionId,
      expectedRevision: 0n, period: "NIGHT" as const,
    };
    const results = await Promise.all([
      store.changePeriod({ ...base, idempotencyKey: "race-period-A" }),
      store.changePeriod({ ...base, idempotencyKey: "race-period-B" }),
    ]);
    expect(results.filter(result => result.ok && !result.value.replayed)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error.code === "REVISION_CONFLICT"))
      .toHaveLength(1);
    const current = await store.current(playerId);
    expect(current).toMatchObject({ period: "NIGHT", phase: "PREPARING", revision: 1n,
      consumedWeekKey: null, elapsedMinutes: 0 });
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("reserves one weekly slot and rejects altered replays", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "once-start");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "once-action",
    };
    const first = await store.advance(input);
    expect(first).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        consumedWeeklySlot: true,
        expedition: { revision: 1n, consumedWeekKey: "2026-10-19" },
      },
    });
    expect(await store.advance(input)).toMatchObject({
      ok: true,
      value: { replayed: true, expedition: { elapsedMinutes: 30 } },
    });
    expect(await store.advance({ ...input, minutes: 60 })).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_INVALID" },
    });
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "once-start",
      }),
    ).toMatchObject({
      ok: true,
      value: { replayed: true, expedition: { phase: "PREPARING" } },
    });
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("serializes simultaneous distinct commands and rejects the stale revision", async () => {
    const playerId = await trainer();
    const original = await prepare(playerId, "race-prepare");
    const input = {
      playerId,
      expeditionId: original.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
    };
    const results = await Promise.all([
      store.advance({ ...input, idempotencyKey: "race-one" }),
      store.advance({ ...input, idempotencyKey: "race-two" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "REVISION_CONFLICT" } },
    ]);
    expect((await store.current(playerId))?.elapsedMinutes).toBe(30);
  });

  it("deduplicates concurrent delivery of the exact same WhatsApp action", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "dup-prepare");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "same-inbox",
    };
    const results = await Promise.all([store.advance(input), store.advance(input)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value.replayed)).toHaveLength(1);
    expect((await store.current(playerId))?.revision).toBe(1n);
    expect(await count("solo_expedition_receipts", playerId)).toBe(2);
  });

  it("blocks the fourth expédition and resets on the local Monday", async () => {
    const playerId = await trainer();
    for (let index = 0; index < 3; index += 1) {
      const initial = await prepare(playerId, "weekly-prepare-" + index);
      const advanced = await store.advance({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        minutes: 30,
        idempotencyKey: "weekly-start-" + index,
      });
      expect(advanced.ok).toBe(true);
      const completed = await store.end({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 1n,
        reason: "VOLUNTARY",
        idempotencyKey: "weekly-end-" + index,
      });
      expect(completed).toMatchObject({
        ok: true,
        value: { expedition: { phase: "ENDED" } },
      });
    }
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "weekly-fourth",
      }),
    ).toMatchObject({ ok: false, error: { code: "FLOW_BLOCKED" } });
    clock.advanceMs(6 * 24 * 60 * 60 * 1000 + 15 * 60 * 60 * 1000);
    expect(
      await store.prepare({
        playerId,
        period: "DAY",
        idempotencyKey: "weekly-next",
      }),
    ).toMatchObject({ ok: true, value: { expedition: { phase: "PREPARING" } } });
  });

  it("continues across weekly reset without consuming an additional slot", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "carry-prepare");
    const started = await store.advance({
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 30,
      idempotencyKey: "carry-first",
    });
    expect(started.ok).toBe(true);
    clock.advanceMs(7 * 24 * 60 * 60 * 1000);
    expect(
      await store.advance({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 1n,
        minutes: 15,
        idempotencyKey: "carry-second",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        consumedWeeklySlot: false,
        expedition: { elapsedMinutes: 45, consumedWeekKey: "2026-10-26" },
      },
    });
  });

  it("cancels without a slot and persists an ended blackout", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "cancel-prepare");
    expect(
      await store.end({
        playerId,
        expeditionId: initial.expeditionId,
        expectedRevision: 0n,
        reason: "CANCELLED",
        idempotencyKey: "cancel-end",
      }),
    ).toMatchObject({
      ok: true,
      value: { expedition: { phase: "ENDED", consumedWeekKey: null } },
    });
    expect(await store.current(playerId)).toBeNull();
    const next = await prepare(playerId, "blackout-prepare");
    expect(
      (
        await store.advance({
          playerId,
          expeditionId: next.expeditionId,
          expectedRevision: 0n,
          minutes: 30,
          idempotencyKey: "blackout-first",
        })
      ).ok,
    ).toBe(true);
    expect(
      await store.end({
        playerId,
        expeditionId: next.expeditionId,
        expectedRevision: 1n,
        reason: "BLACKOUT",
        idempotencyKey: "blackout-end",
      }),
    ).toMatchObject({
      ok: true,
      value: { expedition: { phase: "ENDED", endReason: "BLACKOUT" } },
    });
  });

  it("does not write failed actions or stale commands into the ledger", async () => {
    const playerId = await trainer();
    const initial = await prepare(playerId, "invalid-prepare");
    const input = {
      playerId,
      expeditionId: initial.expeditionId,
      expectedRevision: 0n,
      minutes: 721,
      idempotencyKey: "invalid-length",
    };
    expect(await store.advance(input)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(
      await store.advance({
        ...input,
        expectedRevision: 4n,
        minutes: 30,
        idempotencyKey: "invalid-stale",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(await count("solo_expedition_receipts", playerId)).toBe(1);
    expect((await store.current(playerId))?.revision).toBe(0n);
  });
});
