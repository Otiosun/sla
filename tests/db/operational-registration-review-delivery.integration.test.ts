import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PendingOutboxMessage } from "../../src/modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../src/modules/messaging/ports.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresMessagingRepository } from "../../src/platform/messaging/postgres-messaging-repository.js";
import { PostgresRegistrationMessageRefRepository } from "../../src/platform/registration/postgres-registration-message-ref-repository.js";
import { createOperationalOutboxWorker } from "../../src/runtime/compose-whatsapp-runtime.js";

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

describe.sequential("operational registration review delivery", () => {
  const dbName = `pokemon_operational_review_delivery_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "operational-review-delivery-vitest" });
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

  it("persists the exact provider reply anchor before the operational adapter sends", async () => {
    const playerId = randomUUID();
    const reviewId = randomUUID();
    const outboxMessageId = "00000000-0000-4000-8000-000000000921";
    const correlationId = randomUUID();
    const messageRefs = new PostgresRegistrationMessageRefRepository(pool);
    const observed: PendingOutboxMessage[] = [];

    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO registration_revisions(
         id, player_id, sequence_no, status, schema_version, snapshot_json, revision
       ) VALUES ($1, $2, 1, 'SUBMITTED', 1, '{}'::jsonb, 5)`,
      [reviewId, playerId],
    );
    await pool.query(
      `INSERT INTO outbox_messages(
         id, channel, destination_ref, message_type, payload, idempotency_key, status, correlation_id
       ) VALUES ($1, 'whatsapp', '120363000000000001@g.us', 'TEXT', $2::jsonb, $3, 'PENDING', $4)`,
      [
        outboxMessageId,
        JSON.stringify({
          text: "Nova ficha aguardando revisão.",
          registrationReview: { reviewId, reviewRevision: 5 },
        }),
        `registration-review-notification:${reviewId}:5`,
        correlationId,
      ],
    );

    const adapter: OutboundMessageAdapter = {
      channel: "whatsapp",
      async send(message) {
        observed.push(message);
        expect(
          await messageRefs.findByProviderMessage({
            provider: "baileys",
            providerExternalMessageId: "00000000000040008000000000000921",
          }),
        ).toMatchObject({
          outboxMessageId,
          reviewId,
          reviewRevision: 5,
        });
        return { providerExternalMessageId: "00000000000040008000000000000921" };
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
