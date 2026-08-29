import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  assertDatabaseSchemaCurrent,
  DEFAULT_MIGRATIONS_DIRECTORY,
  loadMigrations,
  runMigrations,
} from "../../src/platform/db/migrations.js";

const databaseUrl = process.env.PHASE16_RECOVERY_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("PHASE16_RECOVERY_DATABASE_URL is required");
}

const PROBE_PLAYER_ID = "00000000-0000-4000-8000-000000001625";
const CURRENT_EXPECTED_LATEST = "0022_world_travel_idempotency.sql";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
});
const previousMigrationsDirectory = await mkdtemp(join(tmpdir(), "pokemon-phase16-prev-"));

try {
  const migrations = await loadMigrations();
  if (migrations.length < 2) {
    throw new Error("Phase 16 forward-migration proof requires at least two migrations");
  }

  const latest = migrations.at(-1);
  if (latest === undefined) {
    throw new Error("Latest migration could not be resolved");
  }
  if (latest.fileName !== CURRENT_EXPECTED_LATEST) {
    throw new Error(
      `Forward-migration proof baseline is stale: expected ${CURRENT_EXPECTED_LATEST}, found ${latest.fileName}`,
    );
  }

  const existingHistory = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS relation",
  );
  if (existingHistory.rows[0]?.relation !== null) {
    throw new Error("Recovery proof database must start empty");
  }

  const previousMigrations = migrations.slice(0, -1);
  for (const migration of previousMigrations) {
    await copyFile(
      join(DEFAULT_MIGRATIONS_DIRECTORY, migration.fileName),
      join(previousMigrationsDirectory, migration.fileName),
    );
  }

  await runMigrations(pool, {
    migrationsDirectory: previousMigrationsDirectory,
    appliedBy: "phase16-previous-version-proof",
  });

  const previousHistory = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM schema_migrations",
  );
  if (previousHistory.rows[0]?.count !== previousMigrations.length.toString()) {
    throw new Error("Previous-version migration history does not match N-1");
  }

  const latestBefore = await pool.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1::bigint",
    [latest.version.toString()],
  );
  if (latestBefore.rowCount !== 0) {
    throw new Error("Latest migration unexpectedly exists in the previous-version database");
  }

  const latestRelationBefore = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.world_travel_receipts')::text AS relation",
  );
  if (latestRelationBefore.rows[0]?.relation !== null) {
    throw new Error("Latest-version relation unexpectedly exists before forward migration");
  }

  await pool.query(
    `INSERT INTO players(id, status)
     VALUES ($1::uuid, 'ACTIVE')`,
    [PROBE_PLAYER_ID],
  );

  const stateBefore = await pool.query<{ state: string }>(
    `SELECT status || ':' || revision::text AS state
     FROM players
     WHERE id = $1::uuid`,
    [PROBE_PLAYER_ID],
  );
  const probeBefore = stateBefore.rows[0]?.state;
  if (probeBefore === undefined) {
    throw new Error("Previous-version durable-state probe was not created");
  }

  await runMigrations(pool, { appliedBy: "phase16-forward-proof" });
  await assertDatabaseSchemaCurrent(pool);

  const currentHistory = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM schema_migrations",
  );
  if (currentHistory.rows[0]?.count !== migrations.length.toString()) {
    throw new Error("Forward migration did not converge to the current migration count");
  }

  const appliedLatest = await pool.query<{ name: string; checksum: string }>(
    `SELECT name, checksum
     FROM schema_migrations
     WHERE version = $1::bigint`,
    [latest.version.toString()],
  );
  const latestRow = appliedLatest.rows[0];
  if (latestRow === undefined) {
    throw new Error("Latest migration was not recorded after forward migration");
  }
  if (latestRow.name !== latest.name || latestRow.checksum !== latest.checksum) {
    throw new Error("Latest migration history does not match the exact current migration file");
  }

  const latestRelationAfter = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.world_travel_receipts')::text AS relation",
  );
  if (latestRelationAfter.rows[0]?.relation !== "world_travel_receipts") {
    throw new Error("Latest migration schema effect is missing after forward migration");
  }

  const stateAfter = await pool.query<{ state: string }>(
    `SELECT status || ':' || revision::text AS state
     FROM players
     WHERE id = $1::uuid`,
    [PROBE_PLAYER_ID],
  );
  if (stateAfter.rows[0]?.state !== probeBefore) {
    throw new Error("Forward migration changed representative durable player state");
  }

  await runMigrations(pool, { appliedBy: "phase16-forward-idempotency-proof" });
  await assertDatabaseSchemaCurrent(pool);

  console.log(
    JSON.stringify({
      proof: "phase16-recovery-migration",
      previousMigrationCount: previousMigrations.length,
      currentMigrationCount: migrations.length,
      latestMigration: latest.fileName,
      durableStatePreserved: true,
      rerunConverged: true,
    }),
  );
} finally {
  await pool.end();
  await rm(previousMigrationsDirectory, { recursive: true, force: true });
}
