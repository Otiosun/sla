import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldServiceSessionService } from "../../src/modules/world-services/session-service.js";
import { ManualClock } from "../../src/platform/clock/index.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresWorldServiceSessionRepository } from "../../src/platform/world-services/postgres-world-service-session-repository.js";
import { createPlayerId, type PlayerId } from "../../src/shared-kernel/ids.js";

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

async function seedPlayerAreaInbox(
  pool: Pool,
  input: {
    readonly playerId: PlayerId;
    readonly areaId: string;
    readonly inboxMessageId: string;
    readonly suffix: string;
  },
): Promise<void> {
  const regionId = randomUUID();
  await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [input.playerId]);
  await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
    regionId,
    `world-service-region-${input.suffix}`,
  ]);
  await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
    input.areaId,
    regionId,
    `world-service-area-${input.suffix}`,
  ]);
  await pool.query(
    `INSERT INTO inbox_messages(
       id, provider, external_message_id, player_id, payload_hash, status
     ) VALUES ($1, 'baileys', $2, $3, $4, 'PROCESSED')`,
    [
      input.inboxMessageId,
      `world-service-message-${input.suffix}`,
      input.playerId,
      "a".repeat(64),
    ],
  );
}

describe.sequential("world service session persistence", () => {
  const dbName = `pokemon_world_service_session_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let service: WorldServiceSessionService;
  let clock: ManualClock;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "world-service-session-vitest" });
    clock = new ManualClock(new Date("2026-09-07T04:00:00.000Z"));
    service = new WorldServiceSessionService(
      new PostgresWorldServiceSessionRepository(pool),
      clock,
    );
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

  it("creates metadata-only scene proof and durable session tables", async () => {
    const tables = await pool.query<{ proof: string | null; session: string | null }>(
      `SELECT
         to_regclass('public.world_service_scene_proofs')::text AS proof,
         to_regclass('public.world_service_sessions')::text AS session`,
    );
    expect(tables.rows[0]).toEqual({
      proof: "world_service_scene_proofs",
      session: "world_service_sessions",
    });

    const proseColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'world_service_scene_proofs'
         AND column_name IN ('text', 'prose', 'content', 'scene_text', 'payload')`,
    );
    expect(proseColumns.rows).toEqual([]);
  });

  it("persists and consumes the newest current-area proof once, then restores the active visit", async () => {
    const playerId = createPlayerId();
    const areaId = randomUUID();
    const olderInbox = randomUUID();
    const newerInbox = randomUUID();
    await seedPlayerAreaInbox(pool, {
      playerId,
      areaId,
      inboxMessageId: olderInbox,
      suffix: randomUUID(),
    });
    await pool.query(
      `INSERT INTO inbox_messages(
         id, provider, external_message_id, player_id, payload_hash, status
       ) VALUES ($1, 'baileys', $2, $3, $4, 'PROCESSED')`,
      [newerInbox, `world-service-message-${randomUUID()}`, playerId, "b".repeat(64)],
    );

    const older = await service.recordSceneProof({
      playerId,
      areaId,
      sourceInboxMessageId: olderInbox,
      text: "um\ndois\ntres\nquatro",
    });
    expect(older.ok).toBe(true);
    clock.advance(1_000);
    const newer = await service.recordSceneProof({
      playerId,
      areaId,
      sourceInboxMessageId: newerInbox,
      text: "cinco\nseis\nsete\noito",
    });
    expect(newer.ok).toBe(true);

    const opened = await service.openVisit({ playerId, areaId, serviceKind: "POKEMART" });
    expect(opened.ok).toBe(true);
    if (!opened.ok || !newer.ok) return;
    expect(opened.value.sceneProofId).toBe(newer.value.proofId);

    const proofs = await pool.query<{
      id: string;
      source_inbox_message_id: string;
      consumed_at: Date | null;
      line_count: number;
    }>(
      `SELECT id, source_inbox_message_id, consumed_at, line_count
       FROM world_service_scene_proofs
       WHERE player_id = $1
       ORDER BY created_at ASC`,
      [playerId],
    );
    expect(proofs.rows).toHaveLength(2);
    expect(proofs.rows.find((row) => row.source_inbox_message_id === newerInbox)).toMatchObject({
      id: newer.value.proofId,
      line_count: 4,
    });
    expect(
      proofs.rows.find((row) => row.source_inbox_message_id === newerInbox)?.consumed_at,
    ).not.toBeNull();
    expect(
      proofs.rows.find((row) => row.source_inbox_message_id === olderInbox)?.consumed_at,
    ).toBeNull();

    const restored = await service.loadActiveSession(playerId);
    expect(restored).toMatchObject({
      ok: true,
      value: {
        sessionId: opened.value.sessionId,
        playerId,
        areaId,
        serviceKind: "POKEMART",
        state: "OPEN",
      },
    });
  });

  it("enforces one active session per player and paired active-prompt identity", async () => {
    const playerId = createPlayerId();
    const areaId = randomUUID();
    const inboxMessageId = randomUUID();
    await seedPlayerAreaInbox(pool, {
      playerId,
      areaId,
      inboxMessageId,
      suffix: randomUUID(),
    });
    await service.recordSceneProof({
      playerId,
      areaId,
      sourceInboxMessageId: inboxMessageId,
      text: "1\n2\n3\n4",
    });
    const opened = await service.openVisit({
      playerId,
      areaId,
      serviceKind: "POKEMON_CENTER",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const prompted = await service.setActivePrompt({
      playerId,
      expectedRevision: opened.value.revision,
      outboxIdempotencyKey: "world-service:prompt:center:1",
      externalMessageId: "WA-WORLD-SERVICE-1",
    });
    expect(prompted).toMatchObject({
      ok: true,
      value: {
        expectedReplyOutboxIdempotencyKey: "world-service:prompt:center:1",
        expectedReplyExternalMessageId: "WA-WORLD-SERVICE-1",
        revision: 1n,
      },
    });

    await expect(
      pool.query(
        `UPDATE world_service_sessions
         SET expected_reply_external_message_id = NULL
         WHERE player_id = $1 AND closed_at IS NULL`,
        [playerId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `INSERT INTO world_service_sessions(
           id, player_id, area_id, service_kind, state, revision, created_at, updated_at
         ) VALUES ($1, $2, $3, 'PC', 'OPEN', 0, now(), now())`,
        [randomUUID(), playerId, areaId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects duplicate scene proofs from the same Inbox message", async () => {
    const playerId = createPlayerId();
    const areaId = randomUUID();
    const inboxMessageId = randomUUID();
    await seedPlayerAreaInbox(pool, {
      playerId,
      areaId,
      inboxMessageId,
      suffix: randomUUID(),
    });

    const first = await service.recordSceneProof({
      playerId,
      areaId,
      sourceInboxMessageId: inboxMessageId,
      text: "1\n2\n3\n4",
    });
    expect(first.ok).toBe(true);

    await expect(
      pool.query(
        `INSERT INTO world_service_scene_proofs(
           id, player_id, area_id, source_inbox_message_id, line_count
         ) VALUES ($1, $2, $3, $4, 4)`,
        [randomUUID(), playerId, areaId, inboxMessageId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
