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
const PROBE_ADMIN_ID = "00000000-0000-4000-8000-000000001627";
const PROBE_SESSION_FINGERPRINT = "d".repeat(64);
const PROBE_SESSION_CREATED_AT = new Date("2026-08-31T17:30:00.000Z");
const PROBE_SESSION_IDLE_EXPIRES_AT = new Date("2026-08-31T17:45:00.000Z");
const PROBE_SESSION_ACCESS_EXPIRES_AT = new Date("2026-08-31T18:30:00.000Z");
const EXPECTED_PREVIOUS_LATEST = "0039_public_verification_rate_limit.sql";
const EXPECTED_CURRENT_LATEST = "0040_trainer_card_ed25519_signature.sql";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
});
const previousMigrationsDirectory = await mkdtemp(join(tmpdir(), "pokemon-phase16-prev-"));

type RateLimitProbeOperation =
  | "session.logout"
  | "player.activity.read"
  | "content.search"
  | "runtime.health.read"
  | "messaging.operations.read"
  | "incident.read"
  | "audit.read"
  | "economy.analytics.read";

async function mutationPrepareBucketExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1::uuid
         AND operation = 'mutation.prepare'
     ) AS exists`,
    [PROBE_ADMIN_ID],
  );
  return result.rows[0]?.exists === true;
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function rateLimitInsertAllowed(operation: RateLimitProbeOperation): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO admin_api_rate_limit_buckets(
         principal_id, operation, window_started_at, request_count, updated_at
       ) VALUES ($1::uuid, $2::text, now(), 1, now())`,
      [PROBE_ADMIN_ID, operation],
    );
    return true;
  } catch (error) {
    if (postgresErrorCode(error) === "23514") return false;
    throw error;
  }
}

async function rateLimitBucketExists(operation: RateLimitProbeOperation): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM admin_api_rate_limit_buckets
       WHERE principal_id = $1::uuid
         AND operation = $2::text
     ) AS exists`,
    [PROBE_ADMIN_ID, operation],
  );
  return result.rows[0]?.exists === true;
}

async function indexExists(indexName: string): Promise<boolean> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass($1)::text AS relation",
    [`public.${indexName}`],
  );
  return result.rows[0]?.relation === indexName;
}

async function accessSessionRelation(): Promise<string | null> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.admin_access_sessions')::text AS relation",
  );
  return result.rows[0]?.relation ?? null;
}

async function sessionRevocationCutoffRelation(): Promise<string | null> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.admin_access_session_revocation_cutoffs')::text AS relation",
  );
  return result.rows[0]?.relation ?? null;
}

async function trainerCardVerificationRelation(): Promise<string | null> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.trainer_card_verifications')::text AS relation",
  );
  return result.rows[0]?.relation ?? null;
}

async function publicVerificationRateLimitRelation(): Promise<string | null> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.public_verification_rate_limit_buckets')::text AS relation",
  );
  return result.rows[0]?.relation ?? null;
}

async function sessionRevocationCutoffShapeExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'admin_access_session_revocation_cutoffs'
         AND column_name = 'environment'
     ) AND EXISTS (
       SELECT 1
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'admin_access_session_revocation_cutoffs'
         AND constraint_row.contype = 'p'
         AND pg_get_constraintdef(constraint_row.oid) LIKE '%(principal_id, environment)%'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

try {
  const migrations = await loadMigrations();
  if (migrations.length < 3) {
    throw new Error("Forward-migration proof requires the runtime and Admin API migrations");
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

  if ((await accessSessionRelation()) === null) {
    throw new Error("Previous-version proof did not create admin_access_sessions");
  }
  if ((await trainerCardVerificationRelation()) === null) {
    throw new Error("Previous-version proof did not create trainer_card_verifications");
  }
  if ((await publicVerificationRateLimitRelation()) === null) {
    throw new Error("Previous-version proof did not create public verification rate-limit storage");
  }

  await assertDatabaseSchemaCurrent(pool, previousMigrationsDirectory);

  const previousHistory = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM schema_migrations",
  );
  if (Number(previousHistory.rows[0]?.count ?? 0) !== previousMigrations.length) {
    throw new Error("Previous-version migration history is incomplete");
  }

  await runMigrations(pool, { appliedBy: "phase16-forward-proof" });
  await assertDatabaseSchemaCurrent(pool);

  const currentHistory = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM schema_migrations",
  );
  if (Number(currentHistory.rows[0]?.count ?? 0) !== migrations.length) {
    throw new Error("Forward migration did not apply exactly one current migration");
  }

  const signatureAlgorithm = await pool.query<{ signature_algorithm: string }>(
    `SELECT column_default::text AS signature_algorithm
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'trainer_card_verifications'
       AND column_name = 'signature_algorithm'`,
  );
  if (!signatureAlgorithm.rows[0]?.signature_algorithm.includes("ED25519")) {
    throw new Error("Forward migration did not switch Trainer Card signatures to ED25519");
  }

  await pool.query(
    `INSERT INTO players(id, status, display_name, external_id)
     VALUES ($1::uuid, 'ACTIVE', 'Recovery Probe', 'phase16-recovery-probe')`,
    [PROBE_PLAYER_ID],
  );
  await pool.query(
    `INSERT INTO admin_users(id, status, display_name)
     VALUES ($1::uuid, 'ACTIVE', 'Recovery Admin')`,
    [PROBE_ADMIN_ID],
  );

  if ((await sessionRevocationCutoffRelation()) === null) {
    throw new Error("Current schema is missing admin_access_session_revocation_cutoffs");
  }
  if (!(await sessionRevocationCutoffShapeExists())) {
    throw new Error("Session revocation cutoff primary key is not environment-scoped");
  }

  await pool.query(
    `INSERT INTO admin_access_sessions(
       token_fingerprint,
       principal_id,
       environment,
       created_at,
       last_seen_at,
       idle_expires_at,
       access_expires_at,
       revoked_at
     ) VALUES ($1, $2::uuid, 'STAGING', $3, $3, $4, $5, NULL)`,
    [
      PROBE_SESSION_FINGERPRINT,
      PROBE_ADMIN_ID,
      PROBE_SESSION_CREATED_AT,
      PROBE_SESSION_IDLE_EXPIRES_AT,
      PROBE_SESSION_ACCESS_EXPIRES_AT,
    ],
  );

  if (!(await rateLimitInsertAllowed("session.logout"))) {
    throw new Error("Current schema rejected session.logout rate-limit bucket");
  }
  if (!(await rateLimitBucketExists("session.logout"))) {
    throw new Error("Current schema did not persist session.logout rate-limit bucket");
  }
  if (!(await indexExists("idx_admin_api_rate_limit_buckets_updated_at"))) {
    throw new Error("Current schema is missing admin API rate-limit cleanup index");
  }
  if (!(await mutationPrepareBucketExists())) {
    await pool.query(
      `INSERT INTO admin_api_rate_limit_buckets(
         principal_id, operation, window_started_at, request_count, updated_at
       ) VALUES ($1::uuid, 'mutation.prepare', now(), 1, now())`,
      [PROBE_ADMIN_ID],
    );
  }

  for (const operation of [
    "player.activity.read",
    "content.search",
    "runtime.health.read",
    "messaging.operations.read",
    "incident.read",
    "audit.read",
    "economy.analytics.read",
  ] as const) {
    if (!(await rateLimitInsertAllowed(operation))) {
      throw new Error(`Current schema rejected ${operation} rate-limit bucket`);
    }
  }
} finally {
  await pool.end();
  await rm(previousMigrationsDirectory, { recursive: true, force: true });
}
