import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { createOperationalOutboxWorker } from "../../src/runtime/compose-whatsapp-runtime.js";

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

describe.sequential("operational world service prompt delivery", () => {
  const dbName = `pokemon_operational_world_prompt_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "operational-world-prompt-vitest" });
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

  it("persists the exact active prompt before the operational adapter sends", async () => {
    const playerId = randomUUID();
    const regionId = randomUUID();
    const areaId = randomUUID();
    const sessionId = randomUUID();
    const outboxMessageId = "00000000-0000-4000-8000-000000000931";
    const outboxIdempotencyKey = `world-service:prompt:${sessionId}`;
    const providerExternalMessageId = "00000000000040008000000000000931";
    const observed: PendingOutboxMessage[] = [];

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query("INSERT INTO regions(id, slug) VALUES ($1, $2)", [
      regionId,
      `operational-world-prompt-region-${randomUUID()}`,
    ]);
    await pool.query("INSERT INTO areas(id, region_id, slug) VALUES ($1, $2, $3)", [
      areaId,
      regionId,
      `operational-world-prompt-area-${randomUUID()}`,
    ]);
    await pool.query(
      `INSERT INTO world_service_sessions(
         id, player_id, area_id, service_kind, state, revision, created_at, updated_at
       ) VALUES ($1, $2, $3, 'PC', 'OPEN', 0, now(), now())`,
      [sessionId, playerId, areaId],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status, correlation_id
       ) VALUES ($1, 'whatsapp', '120363000000000931@g.us', 'TEXT', $2::jsonb, $3, 'PENDING', $4)`,
      [
        outboxMessageId,
        JSON.stringify({
          text: "PC aberto.",
          worldServicePrompt: { playerId, expectedRevision: "0" },
        }),
        outboxIdempotencyKey,
        randomUUID(),
      ],
    );

    const adapter: OutboundMessageAdapter = {
      channel: "whatsapp",
      async send(message) {
        observed.push(message);
        const active = await pool.query<{
          expected_reply_outbox_idempotency_key: string | null;
          expected_reply_external_message_id: string | null;
          revision: string;
        }>(
          `SELECT
             expected_reply_outbox_idempotency_key,
             expected_reply_external_message_id,
             revision::text
           FROM world_service_sessions
           WHERE id = $1`,
          [sessionId],
        );
        expect(active.rows[0]).toEqual({
          expected_reply_outbox_idempotency_key: outboxIdempotencyKey,
          expected_reply_external_message_id: providerExternalMessageId,
          revision: "1",
        });
        return { providerExternalMessageId };
      },
    };

    const worker = createOperationalOutboxWorker(
      pool,
      new PostgresMessagingRepository(pool),
      adapter,
    );

    expect(await worker.runOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(observed).toHaveLength(1);
  });
});
