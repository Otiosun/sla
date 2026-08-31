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
const EXPECTED_PREVIOUS_LATEST = "0027_battle_turn_windows.sql";
const EXPECTED_CURRENT_LATEST = "0028_pvp_challenge_lifecycle.sql";
const EXPECTED_CURRENT_RELATION = "pvp_challenges";

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
    throw new Error("Forward-migration proof requires at least two migrations");
  }

  const previousLatest = migrations.at(-2);
  const latest = migrations.at(-1);
  if (previousLatest === undefined || latest === undefined) {
    throw new Error("Migration baseline could not be resolved");
  }
  if (previousLatest.fileName !== EXPECTED_PREVIOUS_LATEST) {
    throw new Error(
      `Forward-migration previous baseline is stale: expected ${EXPECTED_PREVIOUS_LATEST}, found ${previousLatest.fileName}`,
    );
  }
  if (latest.fileName !== EXPECTED_CURRENT_LATEST) {
    throw new Error(
      `Forward-migration current baseline is stale: expected ${EXPECTED_CURRENT_LATEST}, found ${latest.fileName}`,
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

  const previousLatestApplied = await pool.query<{ name: string; checksum: string }>(
    `SELECT name, checksum
     FROM schema_migrations
     WHERE version = $1::bigint`,
    [previousLatest.version.toString()],
  );
  const previousLatestRow = previousLatestApplied.rows[0];
  if (
    previousLatestRow === undefined ||
    previousLatestRow.name !== previousLatest.name ||
    previousLatestRow.checksum !== previousLatest.checksum
  ) {
    throw new Error("N-1 database is not pinned to the exact previous migration baseline");
  }

  const latestBefore = await pool.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1::bigint",
    [latest.version.toString()],
  );
  if (latestBefore.rowCount !== 0) {
    throw new Error("Latest migration unexpectedly exists in the previous-version database");
  }

  const latestRelationBefore = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.' || $1)::text AS relation",
    [EXPECTED_CURRENT_RELATION],
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

  const appliedLatest = await pool.query<{ name: string; checksum: string; applied_by: string }>(
    `SELECT name, checksum, applied_by
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
  if (latestRow.applied_by !== "phase16-forward-proof") {
    throw new Error("Latest migration was not attributed to the controlled forward step");
  }

  const latestRelationAfter = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.' || $1)::text AS relation",
    [EXPECTED_CURRENT_RELATION],
  );
  if (latestRelationAfter.rows[0]?.relation !== EXPECTED_CURRENT_RELATION) {
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

  const latestAfterRerun = await pool.query<{ applied_by: string }>(
    `SELECT applied_by
     FROM schema_migrations
     WHERE version = $1::bigint`,
    [latest.version.toString()],
  );
  if (latestAfterRerun.rows[0]?.applied_by !== "phase16-forward-proof") {
    throw new Error("Idempotent rerun rewrote latest migration history");
  }

  console.log(
    JSON.stringify({
      proof: "phase16-recovery-migration",
      previousMigrationCount: previousMigrations.length,
      currentMigrationCount: migrations.length,
      previousLatestMigration: previousLatest.fileName,
      latestMigration: latest.fileName,
      durableStatePreserved: true,
      rerunConverged: true,
    }),
  );
} finally {
  await pool.end();
  await rm(previousMigrationsDirectory, { recursive: true, force: true });
}
