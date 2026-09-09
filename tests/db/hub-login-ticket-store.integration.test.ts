import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresHubLoginTicketStore } from "../../src/platform/player-portal/postgres-hub-login-ticket-store.js";

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

describe.sequential("Hub login ticket store on disposable PostgreSQL", () => {
  const dbName = `pokemon_hub_ticket_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "hub-ticket-vitest" });
    await pool.query(`
      CREATE TABLE hub_login_tickets (
        ticket_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
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

  it("persists only the ticket hash and canonical external identity", async () => {
    const store = new PostgresHubLoginTicketStore(pool);
    const ticketHash = "a".repeat(64);
    const expiresAt = new Date("2026-09-09T12:05:00.000Z");

    await store.issue({
      ticketHash,
      identity: { provider: "whatsapp", externalId: "5511999999999" },
      expiresAt,
    });

    const result = await pool.query<{
      ticket_hash: string;
      provider: string;
      external_id: string;
      expires_at: Date;
    }>(
      "SELECT ticket_hash, provider, external_id, expires_at FROM hub_login_tickets WHERE ticket_hash = $1",
      [ticketHash],
    );

    expect(result.rows).toEqual([
      {
        ticket_hash: ticketHash,
        provider: "whatsapp",
        external_id: "5511999999999",
        expires_at: expiresAt,
      },
    ]);
  });

  it("atomically consumes a valid ticket exactly once", async () => {
    const store = new PostgresHubLoginTicketStore(pool);
    const ticketHash = "b".repeat(64);
    await store.issue({
      ticketHash,
      identity: { provider: "whatsapp", externalId: "5588999999999" },
      expiresAt: new Date("2026-09-09T12:05:00.000Z"),
    });

    const [first, second] = await Promise.all([
      store.consume({ ticketHash, now: new Date("2026-09-09T12:01:00.000Z") }),
      store.consume({ ticketHash, now: new Date("2026-09-09T12:01:00.000Z") }),
    ]);

    expect([first, second].filter((value) => value !== null)).toEqual([
      { provider: "whatsapp", externalId: "5588999999999" },
    ]);
    expect([first, second].filter((value) => value === null)).toHaveLength(1);
    expect(
      await pool.query("SELECT 1 FROM hub_login_tickets WHERE ticket_hash = $1", [ticketHash]),
    ).toMatchObject({ rowCount: 0 });
  });

  it("consumes expired tickets without authenticating them", async () => {
    const store = new PostgresHubLoginTicketStore(pool);
    const ticketHash = "c".repeat(64);
    await store.issue({
      ticketHash,
      identity: { provider: "whatsapp", externalId: "5577999999999" },
      expiresAt: new Date("2026-09-09T12:05:00.000Z"),
    });

    await expect(
      store.consume({ ticketHash, now: new Date("2026-09-09T12:05:00.000Z") }),
    ).resolves.toBeNull();
    expect(
      await pool.query("SELECT 1 FROM hub_login_tickets WHERE ticket_hash = $1", [ticketHash]),
    ).toMatchObject({ rowCount: 0 });
  });
});
