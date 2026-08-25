import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const MIGRATION_LOCK_NAMESPACE = 0x504f4b45;
const MIGRATION_LOCK_KEY = 1;

export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../db/migrations/", import.meta.url),
);

export interface MigrationDefinition {
  readonly version: bigint;
  readonly versionText: string;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigrationRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export class MigrationIntegrityError extends MigrationError {
  override readonly name = "MigrationIntegrityError";
}

export class DatabaseSchemaOutOfDateError extends MigrationError {
  override readonly name = "DatabaseSchemaOutOfDateError";
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function loadMigrations(
  directory: string = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<readonly MigrationDefinition[]> {
  const fileNames = (await readdir(directory))
    .filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
    .sort();
  const migrations: MigrationDefinition[] = [];
  const seenVersions = new Set<string>();

  for (const fileName of fileNames) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) continue;
    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      throw new MigrationIntegrityError(`Invalid migration filename: ${fileName}`);
    }
    if (seenVersions.has(versionText)) {
      throw new MigrationIntegrityError(`Duplicate migration version ${versionText}`);
    }
    seenVersions.add(versionText);
    const sql = await readFile(`${directory}/${fileName}`, "utf8");
    migrations.push({
      version: BigInt(versionText),
      versionText,
      name,
      fileName,
      sql,
      checksum: sha256Hex(sql),
    });
  }

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = BigInt(index + 1);
    if (migration === undefined || migration.version !== expectedVersion) {
      throw new MigrationIntegrityError(
        `Migration sequence must be contiguous from 0001; expected ${expectedVersion
          .toString()
          .padStart(4, "0")}`,
      );
    }
  }
  return migrations;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NULL
    )
  `);
}

async function readAppliedMigrations(client: PoolClient): Promise<readonly AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(`
    SELECT version::text AS version, name, checksum
    FROM schema_migrations
    ORDER BY version ASC
  `);
  return result.rows;
}

export async function verifyAppliedMigrations(
  client: PoolClient,
  migrations: readonly MigrationDefinition[],
  requireLatest: boolean,
): Promise<void> {
  const applied = await readAppliedMigrations(client);
  if (applied.length > migrations.length) {
    throw new MigrationIntegrityError(
      `Database has ${applied.length} applied migrations but code only knows ${migrations.length}`,
    );
  }
  for (let index = 0; index < applied.length; index += 1) {
    const appliedMigration = applied[index];
    const fileMigration = migrations[index];
    if (appliedMigration === undefined || fileMigration === undefined) {
      throw new MigrationIntegrityError("Migration history is inconsistent");
    }
    if (BigInt(appliedMigration.version) !== fileMigration.version) {
      throw new MigrationIntegrityError(
        `Migration history gap/order mismatch at database version ${appliedMigration.version}`,
      );
    }
    if (appliedMigration.name !== fileMigration.name) {
      throw new MigrationIntegrityError(
        `Migration ${appliedMigration.version} name mismatch: database=${appliedMigration.name}, file=${fileMigration.name}`,
      );
    }
    if (appliedMigration.checksum !== fileMigration.checksum) {
      throw new MigrationIntegrityError(
        `Migration ${appliedMigration.version} checksum mismatch; applied migrations are immutable`,
      );
    }
  }
  if (requireLatest && applied.length !== migrations.length) {
    throw new DatabaseSchemaOutOfDateError(
      `Database schema is behind: applied=${applied.length}, expected=${migrations.length}`,
    );
  }
}

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_KEY,
  ]);
}

async function releaseMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_KEY,
  ]);
}

export interface RunMigrationsOptions {
  readonly migrationsDirectory?: string;
  readonly appliedBy?: string | null;
}

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<readonly MigrationDefinition[]> {
  const migrations = await loadMigrations(options.migrationsDirectory);
  const client = await pool.connect();
  try {
    await acquireMigrationLock(client);
    await ensureMigrationTable(client);
    await verifyAppliedMigrations(client, migrations, false);
    const applied = await readAppliedMigrations(client);
    const pending = migrations.slice(applied.length);
    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations(version, name, checksum, applied_by)
           VALUES ($1::bigint, $2, $3, $4)`,
          [migration.version.toString(), migration.name, migration.checksum, options.appliedBy ?? null],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationError(`Failed applying ${migration.fileName}: ${String(error)}`);
      }
    }
    await verifyAppliedMigrations(client, migrations, true);
    return migrations;
  } finally {
    try {
      await releaseMigrationLock(client);
    } finally {
      client.release();
    }
  }
}

export async function assertDatabaseSchemaCurrent(
  pool: Pool,
  migrationsDirectory: string = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const migrations = await loadMigrations(migrationsDirectory);
  const client = await pool.connect();
  try {
    await verifyAppliedMigrations(client, migrations, true);
  } finally {
    client.release();
  }
}
