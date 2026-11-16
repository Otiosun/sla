import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";

const IMAGE =
  "postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ENVELOPE = join(ROOT, "scripts/operations/backup-envelope.mjs");
const expectedUrl = "postgresql://pokemon:test-only-password@127.0.0.1:5432/postgres";

function requireIsolated() {
  assert.equal(process.env.CI, "true", "CI only, never an active bot");
  assert.equal(process.env.APP_ENV, "test");
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.WHATSAPP_ENABLED, "false");
  assert.equal(process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS, "1");
  assert.equal(process.env.DATABASE_URL, expectedUrl);
  assert.equal(process.env.MIGRATOR_DATABASE_URL ?? expectedUrl, expectedUrl);
}

function command(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    program + " failed: " + (result.error?.message ?? result.stderr?.slice(-2500)),
  );
  return result.stdout ?? "";
}

function dockerPostgres(dir, envName, databaseUrl, args) {
  command(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--user",
      process.getuid() + ":" + process.getgid(),
      "--env",
      "HOME=/tmp",
      "--env",
      envName,
      "--volume",
      dir + ":/backup",
      IMAGE,
      ...args,
    ],
    { ...process.env, [envName]: databaseUrl },
  );
}

function urlFor(database) {
  const url = new URL(expectedUrl);
  url.pathname = "/" + database;
  return url.toString();
}

async function fingerprint(pool) {
  const results = await pool.query(
    "SELECT version::text AS version, name, checksum FROM schema_migrations ORDER BY version",
  );
  return createHash("sha256").update(JSON.stringify(results.rows)).digest("hex");
}

test("real PG18 -> encrypted dump -> isolated cloned restore plus synthetic session and media", async () => {
  requireIsolated();
  const token = randomBytes(7).toString("hex");
  const sourceName = "beyond_proof_source_" + token;
  const restoredName = "beyond_proof_clone_" + token;
  const temp = await mkdtemp(join(tmpdir(), "beyond-restore-"));
  const key = randomBytes(32).toString("base64");
  const syntheticPlayer = randomUUID();
  const admin = new Pool({ connectionString: expectedUrl, max: 1 });
  let source;
  let clone;
  let sourceCreated = false;
  let cloneCreated = false;

  try {
    await admin.query('CREATE DATABASE "' + sourceName + '"');
    sourceCreated = true;
    source = new Pool({ connectionString: urlFor(sourceName), max: 2 });
    command("pnpm", ["db:migrate"], {
      ...process.env,
      DATABASE_URL: urlFor(sourceName),
      MIGRATOR_DATABASE_URL: urlFor(sourceName),
      MIGRATION_APPLIED_BY: "encrypted-clone-ci-only",
    });
    const draft = await readFile(join(ROOT, "db/candidates/0080_solo_exploration_v4.sql"), "utf8");
    await source.query(draft);
    await source.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [syntheticPlayer]);
    const baseline = await fingerprint(source);
    const migrationCount = await source.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(migrationCount.rows[0].n, 79);

    // Dump custom-format PG18 through the pinned Docker client, never a real database.
    dockerPostgres(temp, "SOURCE_DATABASE_URL", urlFor(sourceName), [
      "sh",
      "-ceu",
      'pg_dump --dbname "$SOURCE_DATABASE_URL" --format custom --no-owner --no-acl --file /backup/pg18.dump',
    ]);
    assert.ok((await stat(join(temp, "pg18.dump"))).size > 2048);
    command("node", [ENVELOPE, "encrypt", join(temp, "pg18.dump"), join(temp, "pg18.pbv4")], {
      ...process.env,
      BACKUP_ENCRYPTION_KEY_B64: key,
    });
    await rm(join(temp, "pg18.dump"));
    command(
      "node",
      [ENVELOPE, "decrypt", join(temp, "pg18.pbv4"), join(temp, "pg18.restored.dump")],
      {
        ...process.env,
        BACKUP_ENCRYPTION_KEY_B64: key,
        ALLOW_DISPOSABLE_BACKUP_RESTORE: "1",
      },
    );
    dockerPostgres(temp, "RESTORE_DATABASE_URL", urlFor(sourceName), [
      "pg_restore",
      "--list",
      "/backup/pg18.restored.dump",
    ]);

    // A backup only proves recovery when the original has diverged.
    await source.query("UPDATE players SET status='SUSPENDED',revision=revision+1 WHERE id=$1", [
      syntheticPlayer,
    ]);
    await admin.query('CREATE DATABASE "' + restoredName + '"');
    cloneCreated = true;
    dockerPostgres(temp, "RESTORE_DATABASE_URL", urlFor(restoredName), [
      "sh",
      "-ceu",
      'pg_restore --dbname "$RESTORE_DATABASE_URL" --exit-on-error --no-owner --no-acl /backup/pg18.restored.dump',
    ]);
    clone = new Pool({ connectionString: urlFor(restoredName), max: 2 });

    const original = await source.query(
      "SELECT status,revision::int AS revision FROM players WHERE id=$1",
      [syntheticPlayer],
    );
    const recovered = await clone.query(
      "SELECT status,revision::int AS revision FROM players WHERE id=$1",
      [syntheticPlayer],
    );
    assert.deepEqual(original.rows[0], { status: "SUSPENDED", revision: 1 });
    assert.deepEqual(recovered.rows[0], { status: "ACTIVE", revision: 0 });
    assert.equal(await fingerprint(clone), baseline);
    const tables = await clone.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'solo_%'",
    );
    assert.equal(tables.rows[0].n, 10);
    const policies = await clone.query(
      "SELECT count(*)::int AS n FROM solo_resource_loot_policies",
    );
    assert.equal(policies.rows[0].n, 0);
    const client = await clone.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO players(id,status) VALUES ($1,'ACTIVE')", [randomUUID()]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Archive only harmless synthetic fixture paths; never inspect a real WhatsApp session.
    const inputAssets = join(temp, "synthetic-input");
    const outputAssets = join(temp, "synthetic-output");
    await mkdir(join(inputAssets, "media"), { recursive: true });
    await mkdir(join(inputAssets, "session"), { recursive: true });
    await mkdir(outputAssets);
    const fakeSession = Buffer.from("FAKE-NO-WHATSAPP-CREDENTIALS");
    const fakeMedia = randomBytes(1024);
    await writeFile(join(inputAssets, "session", "creds.json"), fakeSession);
    await writeFile(join(inputAssets, "media", "image.png"), fakeMedia);
    command("tar", ["-czf", join(temp, "assets.tar.gz"), "-C", inputAssets, "session", "media"]);
    command("node", [ENVELOPE, "encrypt", join(temp, "assets.tar.gz"), join(temp, "assets.pbv4")], {
      ...process.env,
      BACKUP_ENCRYPTION_KEY_B64: key,
    });
    await rm(join(temp, "assets.tar.gz"));
    command(
      "node",
      [ENVELOPE, "decrypt", join(temp, "assets.pbv4"), join(temp, "assets.restored.tar.gz")],
      {
        ...process.env,
        BACKUP_ENCRYPTION_KEY_B64: key,
        ALLOW_DISPOSABLE_BACKUP_RESTORE: "1",
      },
    );
    command("tar", ["-xzf", join(temp, "assets.restored.tar.gz"), "-C", outputAssets]);
    assert.deepEqual(await readFile(join(outputAssets, "session", "creds.json")), fakeSession);
    assert.deepEqual(await readFile(join(outputAssets, "media", "image.png")), fakeMedia);
  } finally {
    if (clone) await clone.end();
    if (source) await source.end();
    for (const [name, created] of [
      [restoredName, cloneCreated],
      [sourceName, sourceCreated],
    ]) {
      if (!created) continue;
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [name],
      );
      await admin.query('DROP DATABASE IF EXISTS "' + name + '"');
    }
    await admin.end();
    await rm(temp, { recursive: true, force: true });
  }
});
