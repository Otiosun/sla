import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMessagingOperationsReadRepository } from "../../src/platform/admin/postgres-messaging-operations-read-repository.js";
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

describe.sequential("PostgresMessagingOperationsReadRepository", () => {
  const dbName = `pokemon_messaging_ops_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "messaging-ops-read-proof" });

    await pool.query(
      `INSERT INTO inbox_messages (
         id, provider, external_message_id, payload_hash, status, received_at,
         processed_at, last_error_code, correlation_id, normalized_payload,
         attempts, processing_started_at
       ) VALUES
       ('11111111-1111-4111-8111-111111111111', 'WHATSAPP', 'secret-provider-id-1', $1, 'PROCESSED', $2, $3, NULL, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $4::jsonb, 1, $5),
       ('22222222-2222-4222-8222-222222222222', 'WHATSAPP', 'secret-provider-id-2', $6, 'FAILED', $7, NULL, 'SECRET_ERROR_DETAIL', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $8::jsonb, 3, $9)`,
      [
        "a".repeat(64),
        new Date("2026-09-01T10:00:00.000Z"),
        new Date("2026-09-01T10:00:05.000Z"),
        JSON.stringify({ text: "SECRET_INBOX_PAYLOAD" }),
        new Date("2026-09-01T10:00:01.000Z"),
        "b".repeat(64),
        new Date("2026-09-01T11:00:00.000Z"),
        JSON.stringify({ text: "SECRET_FAILED_PAYLOAD" }),
        new Date("2026-09-01T11:00:01.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO outbox_messages (
         id, channel, destination_ref, message_type, payload, idempotency_key,
         status, attempts, next_attempt_at, created_at, sent_at, last_error_code,
         correlation_id, causation_id, sending_started_at
       ) VALUES
       ('33333333-3333-4333-8333-333333333333', 'WHATSAPP', 'SECRET_DESTINATION_1', 'TEXT', $1::jsonb, 'idem-sent-1', 'SENT', 1, NULL, $2, $3, NULL, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', NULL, $4),
       ('44444444-4444-4444-8444-444444444444', 'WHATSAPP', 'SECRET_DESTINATION_2', 'TEXT', $5::jsonb, 'idem-dead-1', 'DEAD', 8, NULL, $6, NULL, 'SECRET_DEAD_ERROR', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', NULL, NULL)`,
      [
        JSON.stringify({ text: "SECRET_OUTBOX_PAYLOAD" }),
        new Date("2026-09-01T10:30:00.000Z"),
        new Date("2026-09-01T10:30:03.000Z"),
        new Date("2026-09-01T10:30:01.000Z"),
        JSON.stringify({ text: "SECRET_DEAD_PAYLOAD" }),
        new Date("2026-09-01T11:30:00.000Z"),
      ],
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

  it("returns bounded queue metadata and a dedicated dead-letter projection", async () => {
    const repository = new PostgresMessagingOperationsReadRepository(pool);
    const result = await repository.readSnapshot(25);

    expect(result.inbox.counts).toEqual({ RECEIVED: 0, PROCESSING: 0, PROCESSED: 1, FAILED: 1 });
    expect(result.inbox.recent.map((row) => row.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(result.outbox.counts).toEqual({ PENDING: 0, SENDING: 0, SENT: 1, FAILED: 0, DEAD: 1 });
    expect(result.outbox.deadLetter).toHaveLength(1);
    expect(result.outbox.deadLetter[0]?.id).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("never projects provider ids, payloads, destinations, error text or causality identifiers", async () => {
    const repository = new PostgresMessagingOperationsReadRepository(pool);
    const result = await repository.readSnapshot(25);
    const serialized = JSON.stringify(result);

    for (const secret of [
      "SECRET_INBOX_PAYLOAD",
      "SECRET_FAILED_PAYLOAD",
      "secret-provider-id-1",
      "secret-provider-id-2",
      "SECRET_OUTBOX_PAYLOAD",
      "SECRET_DEAD_PAYLOAD",
      "SECRET_DESTINATION_1",
      "SECRET_DESTINATION_2",
      "SECRET_ERROR_DETAIL",
      "SECRET_DEAD_ERROR",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("enforces the server-owned maximum even if a larger limit reaches the repository", async () => {
    const repository = new PostgresMessagingOperationsReadRepository(pool);
    await expect(repository.readSnapshot(1000)).rejects.toThrow(/limit/i);
  });
});
