import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAutoBattleTerminalWhatsAppProjector } from "../../src/platform/battle/postgres-auto-battle-terminal-whatsapp-projector.js";
import { runMigrations } from "../../src/platform/db/migrations.js";

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

describe("AUTO battle terminal WhatsApp projector PostgreSQL integration", () => {
  const dbName = `pokemon_auto_terminal_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 4 });
    await runMigrations(pool, { appliedBy: "auto-terminal-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();

    const deadline = Date.now() + 5_000;
    while (true) {
      const activeConnections = await adminPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if (activeConnections.rows[0]?.count === "0") break;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for PostgreSQL connections to close for ${dbName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("plans and executes the terminal projection query against the real inbox UUID schema", async () => {
    const result = await new PostgresAutoBattleTerminalWhatsAppProjector(pool).runOnce(10);

    expect(result).toEqual({ claimed: 0, projected: 0 });
  });
});
