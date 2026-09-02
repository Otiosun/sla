import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRegistrationMessageRefRepository } from "../../src/platform/registration/postgres-registration-message-ref-repository.js";
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

describe.sequential("PostgresRegistrationMessageRefRepository", () => {
  const dbName = `pokemon_registration_message_refs_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: PostgresRegistrationMessageRefRepository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "registration-message-refs-vitest" });
    repository = new PostgresRegistrationMessageRefRepository(pool);
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

  it("durably resolves the exact submitted review and revision by provider external message id", async () => {
    const playerId = randomUUID();
    const reviewId = randomUUID();
    const outboxMessageId = randomUUID();
    const correlationId = randomUUID();

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO registration_revisions(
         id, player_id, sequence_no, status, schema_version, snapshot_json, revision
       ) VALUES ($1, $2, 1, 'SUBMITTED', 1, '{}'::jsonb, 3)`,
      [reviewId, playerId],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status, correlation_id
       ) VALUES ($1, 'whatsapp', 'reception@g.us', 'TEXT', '{}'::jsonb, $2, 'PENDING', $3)`,
      [outboxMessageId, `review-notification:${reviewId}`, correlationId],
    );

    await repository.record({
      provider: "baileys",
      providerExternalMessageId: "3EB0EXACTREVIEW",
      outboxMessageId,
      reviewId,
      reviewRevision: 3,
    });

    expect(
      await repository.findByProviderMessage({
        provider: "baileys",
        providerExternalMessageId: "3EB0EXACTREVIEW",
      }),
    ).toEqual({
      provider: "baileys",
      providerExternalMessageId: "3EB0EXACTREVIEW",
      outboxMessageId,
      reviewId,
      reviewRevision: 3,
    });

    expect(
      await repository.findByProviderMessage({
        provider: "baileys",
        providerExternalMessageId: "missing-message",
      }),
    ).toBeNull();
  });
});
