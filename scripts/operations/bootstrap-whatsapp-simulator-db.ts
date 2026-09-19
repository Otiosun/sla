import { Pool } from "pg";
import { assertDatabaseSchemaCurrent, runMigrations } from "../../src/platform/db/migrations.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function databaseName(url: URL): string {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (name.length === 0) throw new Error("PostgreSQL URL must include a database name");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsupported database name for simulator bootstrap: ${name}`);
  }
  return name;
}

function normalizedPostgresProtocol(url: URL): string {
  return url.protocol === "postgres:" ? "postgresql:" : url.protocol;
}

function normalizedPort(url: URL): string {
  return url.port.length === 0 ? "5432" : url.port;
}

function sameServer(left: URL, right: URL): boolean {
  return (
    normalizedPostgresProtocol(left) === normalizedPostgresProtocol(right) &&
    left.hostname === right.hostname &&
    normalizedPort(left) === normalizedPort(right)
  );
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function maintenanceUrl(source: URL): string {
  const url = new URL(source);
  url.pathname = "/postgres";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function existingTables(pool: Pool, names: readonly string[]): Promise<ReadonlySet<string>> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT name AS table_name
     FROM unnest($1::text[]) AS requested(name)
     WHERE to_regclass('public.' || name) IS NOT NULL`,
    [names],
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function sanitizeSimulatorState(pool: Pool): Promise<void> {
  const tables = await existingTables(pool, [
    "whatsapp_auth_keys",
    "whatsapp_auth_sessions",
    "inbox_messages",
    "outbox_messages",
    "messaging_rate_limit_buckets",
  ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tables.has("whatsapp_auth_keys") && tables.has("whatsapp_auth_sessions")) {
      await client.query("TRUNCATE TABLE whatsapp_auth_keys, whatsapp_auth_sessions CASCADE");
    }
    if (tables.has("inbox_messages") && tables.has("outbox_messages")) {
      await client.query("TRUNCATE TABLE inbox_messages, outbox_messages CASCADE");
    }
    if (tables.has("messaging_rate_limit_buckets")) {
      await client.query("TRUNCATE TABLE messaging_rate_limit_buckets");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const sourceRaw = requiredEnv("DATABASE_URL");
const simulatorRaw = requiredEnv("SIMULATOR_DATABASE_URL");
if (sourceRaw === simulatorRaw) {
  throw new Error("SIMULATOR_DATABASE_URL must differ from DATABASE_URL");
}

const sourceUrl = new URL(sourceRaw);
const simulatorUrl = new URL(simulatorRaw);
if (!sameServer(sourceUrl, simulatorUrl)) {
  throw new Error(
    "Simulator bootstrap requires DATABASE_URL and SIMULATOR_DATABASE_URL on the same PostgreSQL server",
  );
}

const sourceName = databaseName(sourceUrl);
const simulatorName = databaseName(simulatorUrl);
if (sourceName === simulatorName) {
  throw new Error("Simulator database name must differ from the source database");
}
if (new Set(["postgres", "template0", "template1"]).has(simulatorName)) {
  throw new Error(
    `Refusing to use reserved PostgreSQL database as simulator target: ${simulatorName}`,
  );
}

const reset = process.env.SIMULATOR_RESET === "1";
const fresh = process.env.SIMULATOR_FRESH === "1";
const adminPool = new Pool({
  connectionString: maintenanceUrl(sourceUrl),
  max: 1,
});

try {
  if (!fresh) {
    const sourceConnections = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()
         AND backend_type = 'client backend'`,
      [sourceName],
    );
    const activeSourceConnections = Number(sourceConnections.rows[0]?.count ?? "0");
    if (activeSourceConnections > 0) {
      throw new Error(
        `Source database ${sourceName} has ${activeSourceConnections} active client connection(s). Stop local runtimes before cloning.`,
      );
    }
  }

  const existing = await adminPool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [simulatorName],
  );
  if (existing.rows[0]?.exists === true) {
    if (!reset) {
      throw new Error(
        `Simulator database ${simulatorName} already exists. Set SIMULATOR_RESET=1 to recreate it.`,
      );
    }
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [simulatorName],
    );
    await adminPool.query(`DROP DATABASE ${quotedIdentifier(simulatorName)}`);
  }

  if (fresh) {
    await adminPool.query(`CREATE DATABASE ${quotedIdentifier(simulatorName)}`);
    console.log(`[sim-bootstrap] created fresh ${simulatorName}`);
  } else {
    await adminPool.query(
      `CREATE DATABASE ${quotedIdentifier(simulatorName)} TEMPLATE ${quotedIdentifier(sourceName)}`,
    );
    console.log(`[sim-bootstrap] cloned ${sourceName} -> ${simulatorName}`);
  }
} finally {
  await adminPool.end();
}

const simulatorPool = new Pool({
  connectionString: simulatorRaw,
  max: 4,
});

try {
  // Strip cloned provider credentials and messaging queues before any migration or runtime work.
  await sanitizeSimulatorState(simulatorPool);

  await runMigrations(simulatorPool, {
    appliedBy: "whatsapp-simulator-bootstrap",
  });

  // Newer migrations may introduce sensitive transport tables; sanitize a second time.
  await sanitizeSimulatorState(simulatorPool);
  await assertDatabaseSchemaCurrent(simulatorPool);

  const [groups, players, admins, authRows, activeRelease] = await Promise.all([
    simulatorPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM community_groups
       WHERE provider = 'baileys' AND status = 'ACTIVE'`,
    ),
    simulatorPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM player_identities
       WHERE provider = 'baileys' AND status = 'ACTIVE'`,
    ),
    simulatorPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM admin_principals
       WHERE status = 'ACTIVE' AND identity_ref LIKE 'whatsapp:%'`,
    ),
    simulatorPool.query<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM whatsapp_auth_sessions) +
         (SELECT COUNT(*) FROM whatsapp_auth_keys)
       )::text AS count`,
    ),
    simulatorPool.query<{ release_no: string; name: string }>(
      `SELECT release.release_no::text, release.name
       FROM content_release_pointers pointer
       JOIN content_releases release ON release.id = pointer.content_release_id
       WHERE pointer.pointer_key = 'ACTIVE'`,
    ),
  ]);

  const release = activeRelease.rows[0];
  console.log("[sim-bootstrap] ready");
  console.log(`[sim-bootstrap] database=${simulatorName}`);
  console.log(`[sim-bootstrap] activeGroups=${groups.rows[0]?.count ?? "0"}`);
  console.log(`[sim-bootstrap] activePlayerIdentities=${players.rows[0]?.count ?? "0"}`);
  console.log(`[sim-bootstrap] activeWhatsAppAdmins=${admins.rows[0]?.count ?? "0"}`);
  console.log(`[sim-bootstrap] authRows=${authRows.rows[0]?.count ?? "0"}`);
  console.log(
    `[sim-bootstrap] activeRelease=${release === undefined ? "(none)" : `${release.release_no} | ${release.name}`}`,
  );
  console.log("[sim-bootstrap] real WhatsApp auth/session material is absent from the clone");
} finally {
  await simulatorPool.end();
}
