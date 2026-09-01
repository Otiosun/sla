import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresIncidentCenterReadRepository } from "../../src/platform/admin/postgres-incident-center-read-repository.js";
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

describe.sequential("PostgresIncidentCenterReadRepository", () => {
  const dbName = `pokemon_incident_center_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "incident-center-read-proof" });

    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES ('11111111-1111-4111-8111-111111111111', 'incident-proof-admin', 'ACTIVE')`,
    );
    await pool.query(
      `INSERT INTO admin_operations(
         id, principal_id, capability_key, operation_type, target_type, target_id,
         risk_tier, status, reason, idempotency_key, input, result, correlation_id,
         created_at, request_fingerprint, updated_at
       ) VALUES
       ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'player.profile.edit', 'player.profile.edit', 'PLAYER', '77777777-7777-4777-8777-777777777777', 2, 'FAILED', 'SECRET_ADMIN_REASON', 'incident-admin-failed', $1::jsonb, $2::jsonb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $3, 'incident-fingerprint-failed', $4),
       ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'player.read', 'player.read', 'PLAYER', '77777777-7777-4777-8777-777777777777', 0, 'DRAFT', NULL, 'incident-admin-draft', '{}'::jsonb, NULL, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', $5, 'incident-fingerprint-draft', $5)`,
      [
        JSON.stringify({ secret: "SECRET_ADMIN_INPUT" }),
        JSON.stringify({ secret: "SECRET_ADMIN_RESULT" }),
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T12:05:00.000Z"),
        new Date("2026-09-01T11:00:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO inbox_messages(
         id, provider, external_message_id, payload_hash, status, received_at,
         last_error_code, correlation_id, normalized_payload, attempts, processing_started_at
       ) VALUES
       ('44444444-4444-4444-8444-444444444444', 'WHATSAPP', 'SECRET_PROVIDER_ID', $1, 'FAILED', $2, 'SECRET_INBOX_ERROR', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $3::jsonb, 3, $4)`,
      [
        "a".repeat(64),
        new Date("2026-09-01T12:30:00.000Z"),
        JSON.stringify({ text: "SECRET_INBOX_PAYLOAD" }),
        new Date("2026-09-01T12:31:00.000Z"),
      ],
    );

    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key,
         status, attempts, next_attempt_at, created_at, last_error_code,
         correlation_id, causation_id, sending_started_at
       ) VALUES
       ('55555555-5555-4555-8555-555555555555', 'WHATSAPP', 'SECRET_DESTINATION', 'TEXT', $1::jsonb, 'incident-outbox-dead', 'DEAD', 8, NULL, $2, 'SECRET_OUTBOX_ERROR', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $3)`,
      [
        JSON.stringify({ text: "SECRET_OUTBOX_PAYLOAD" }),
        new Date("2026-09-01T13:00:00.000Z"),
        new Date("2026-09-01T13:01:00.000Z"),
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

  it("returns only recent correlated failure/dead signals in global recency order", async () => {
    const repository = new PostgresIncidentCenterReadRepository(pool);
    const result = await repository.readRecent(25);

    expect(result.map((row) => [row.source, row.state, row.correlationId])).toEqual([
      ["OUTBOX", "DEAD", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      ["INBOX", "FAILED", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ["ADMIN_OPERATION", "FAILED", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ]);
    expect(result.some((row) => row.id === "33333333-3333-4333-8333-333333333333")).toBe(false);
  });

  it("never projects administrative reason/input/result or messaging payload/destination/error/causation", async () => {
    const repository = new PostgresIncidentCenterReadRepository(pool);
    const serialized = JSON.stringify(await repository.readRecent(25));
    for (const secret of [
      "SECRET_ADMIN_REASON",
      "SECRET_ADMIN_INPUT",
      "SECRET_ADMIN_RESULT",
      "SECRET_PROVIDER_ID",
      "SECRET_INBOX_ERROR",
      "SECRET_INBOX_PAYLOAD",
      "SECRET_DESTINATION",
      "SECRET_OUTBOX_ERROR",
      "SECRET_OUTBOX_PAYLOAD",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("enforces the server-owned maximum", async () => {
    const repository = new PostgresIncidentCenterReadRepository(pool);
    await expect(repository.readRecent(1000)).rejects.toThrow(/limit/i);
  });
});
