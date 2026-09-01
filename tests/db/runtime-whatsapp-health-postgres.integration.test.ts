import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRuntimeWhatsappHealthRepository } from "../../src/platform/admin/postgres-runtime-whatsapp-health-repository.js";
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

const OLD_STAGING_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_STAGING_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCTION_INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const OLD_REVISION = "a".repeat(40);
const NEW_REVISION = "b".repeat(40);
const PRODUCTION_REVISION = "c".repeat(40);

describe.sequential("PostgresRuntimeWhatsappHealthRepository", () => {
  const dbName = `pokemon_runtime_health_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "runtime-health-read-proof" });

    await pool.query(
      `INSERT INTO runtime_instances (
         instance_id,
         environment,
         deployment_revision,
         whatsapp_session_key,
         provider_state,
         started_at,
         last_connected_at,
         last_heartbeat_at,
         last_disconnect_at,
         shutdown_reason
       ) VALUES
       ($1, 'staging', $2, 'secret-old-staging', 'DISCONNECTED', $3, $4, $5, $6, 'sensitive-old-reason'),
       ($7, 'staging', $8, 'secret-new-staging', 'CONNECTED', $9, $10, $11, NULL, NULL),
       ($12, 'production', $13, 'secret-production', 'CONNECTED', $14, $15, $16, NULL, NULL)`,
      [
        OLD_STAGING_INSTANCE_ID,
        OLD_REVISION,
        new Date("2026-09-01T07:00:00.000Z"),
        new Date("2026-09-01T07:01:00.000Z"),
        new Date("2026-09-01T07:10:00.000Z"),
        new Date("2026-09-01T07:09:00.000Z"),
        NEW_STAGING_INSTANCE_ID,
        NEW_REVISION,
        new Date("2026-09-01T08:00:00.000Z"),
        new Date("2026-09-01T08:01:00.000Z"),
        new Date("2026-09-01T08:10:00.000Z"),
        PRODUCTION_INSTANCE_ID,
        PRODUCTION_REVISION,
        new Date("2026-09-01T09:00:00.000Z"),
        new Date("2026-09-01T09:01:00.000Z"),
        new Date("2026-09-01T09:10:00.000Z"),
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

  it("returns only the latest runtime evidence for the requested environment", async () => {
    const repository = new PostgresRuntimeWhatsappHealthRepository(pool);

    await expect(repository.findLatest("staging")).resolves.toEqual({
      providerState: "CONNECTED",
      deploymentRevision: NEW_REVISION,
      startedAt: new Date("2026-09-01T08:00:00.000Z"),
      lastConnectedAt: new Date("2026-09-01T08:01:00.000Z"),
      lastHeartbeatAt: new Date("2026-09-01T08:10:00.000Z"),
      lastDisconnectAt: null,
      stoppedAt: null,
    });
  });

  it("does not project the WhatsApp session key or shutdown reason", async () => {
    const repository = new PostgresRuntimeWhatsappHealthRepository(pool);
    const result = await repository.findLatest("staging");

    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "deploymentRevision",
      "lastConnectedAt",
      "lastDisconnectAt",
      "lastHeartbeatAt",
      "providerState",
      "startedAt",
      "stoppedAt",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-new-staging");
    expect(JSON.stringify(result)).not.toContain("shutdown_reason");
  });

  it("keeps environments isolated and returns null when none exists", async () => {
    const repository = new PostgresRuntimeWhatsappHealthRepository(pool);

    await expect(repository.findLatest("production")).resolves.toMatchObject({
      providerState: "CONNECTED",
      deploymentRevision: PRODUCTION_REVISION,
    });

    await pool.query("DELETE FROM runtime_instances WHERE environment = 'production'");
    await expect(repository.findLatest("production")).resolves.toBeNull();
  });
});
