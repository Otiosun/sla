import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

export const MIGRATOR_ROLE = "pokemon_migrator";
export const RUNTIME_ROLE = "pokemon_runtime";
const APPLY_CONFIRMATION = "TRANSFER_POSTGRES_OWNERSHIP";
const RELATION_KINDS = ["r", "p", "S", "v", "m"] as const;

type RelationKind = (typeof RELATION_KINDS)[number];
type Mode = "dry-run" | "apply";

export type PublicRelation = {
  readonly relkind: RelationKind;
  readonly relname: string;
  readonly owner: string;
};

export type TransitionReport = {
  readonly decision: "SAFE_TO_APPLY" | "BLOCKED";
  readonly roles: Readonly<Record<string, "present" | "absent">>;
  readonly transferCounts: Readonly<Record<RelationKind, number>>;
  readonly unexpectedOwnerCount: number;
  readonly grantsToReconcile: readonly string[];
};

export type PsqlRunner = (input: {
  readonly connectionString: string;
  readonly script: "roles.sql" | "runtime_grants.sql";
  readonly variables: Readonly<Record<string, string>>;
}) => Promise<void>;

const relationsQuery = `SELECT c.relkind, c.relname, pg_get_userbyid(c.relowner) AS owner
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = ANY($1::"char"[])
 ORDER BY c.relkind, c.relname`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function commandFor(kind: RelationKind): "TABLE" | "SEQUENCE" | "VIEW" | "MATERIALIZED VIEW" {
  if (kind === "r" || kind === "p") return "TABLE";
  if (kind === "S") return "SEQUENCE";
  if (kind === "v") return "VIEW";
  return "MATERIALIZED VIEW";
}

function zeroCounts(): Record<RelationKind, number> {
  return { r: 0, p: 0, S: 0, v: 0, m: 0 };
}

function databaseName(connectionString: string): string {
  const parsed = new URL(connectionString);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name.length === 0) throw new Error("DATABASE_URL must name a database");
  return name;
}

function connectionEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const parsed = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: databaseName(connectionString),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    ...(parsed.searchParams.has("sslmode")
      ? { PGSSLMODE: parsed.searchParams.get("sslmode") ?? "" }
      : {}),
  };
}

const operationDirectory = fileURLToPath(new URL(".", import.meta.url));
const bootstrapDirectory = fileURLToPath(new URL("../../db/bootstrap/", import.meta.url));

const runPsql: PsqlRunner = async ({ connectionString, script, variables }) => {
  const args = ["--no-psqlrc", "--set", "ON_ERROR_STOP=1"];
  for (const [key, value] of Object.entries(variables)) args.push("--set", `${key}=${value}`);
  args.push("--file", `${bootstrapDirectory}${script}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("psql", args, {
      cwd: operationDirectory,
      env: connectionEnvironment(connectionString),
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("psql is required to apply the role transition")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Canonical ${script} reconciliation failed (exit ${code ?? "unknown"})`));
    });
  });
};

export function transitionMode(args: readonly string[], env: NodeJS.ProcessEnv): Mode {
  if (!args.includes("--apply")) return "dry-run";
  if (env.LEGACY_DB_ROLE_TRANSITION_CONFIRM !== APPLY_CONFIRMATION) {
    throw new Error(
      "--apply requires LEGACY_DB_ROLE_TRANSITION_CONFIRM=TRANSFER_POSTGRES_OWNERSHIP",
    );
  }
  return "apply";
}

async function inspect(
  client: PoolClient,
  expectedDatabase: string,
): Promise<{
  readonly report: TransitionReport;
  readonly relations: readonly PublicRelation[];
}> {
  const session = await client.query<{
    current_user: string;
    session_user: string;
    database: string;
  }>("SELECT current_user, session_user, current_database() AS database");
  const identity = session.rows[0];
  if (
    identity?.current_user !== "postgres" ||
    identity.session_user !== "postgres" ||
    identity.database !== expectedDatabase
  ) {
    throw new Error(
      "Blocked: this operation requires the postgres owner on the DATABASE_URL target",
    );
  }

  const roles = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
    [[MIGRATOR_ROLE, RUNTIME_ROLE]],
  );
  const present = new Set(roles.rows.map((row) => row.rolname));
  const relations = await client.query<PublicRelation>(relationsQuery, [RELATION_KINDS]);
  const unexpected = relations.rows.filter(
    (relation) => relation.owner !== "postgres" && relation.owner !== MIGRATOR_ROLE,
  );
  const counts = zeroCounts();
  for (const relation of relations.rows)
    if (relation.owner === "postgres") counts[relation.relkind] += 1;
  return {
    relations: relations.rows,
    report: {
      decision: unexpected.length === 0 ? "SAFE_TO_APPLY" : "BLOCKED",
      roles: {
        [MIGRATOR_ROLE]: present.has(MIGRATOR_ROLE) ? "present" : "absent",
        [RUNTIME_ROLE]: present.has(RUNTIME_ROLE) ? "present" : "absent",
      },
      transferCounts: counts,
      unexpectedOwnerCount: unexpected.length,
      grantsToReconcile: ["db/bootstrap/runtime_grants.sql"],
    },
  };
}

function assertSafe(report: TransitionReport): void {
  if (report.decision !== "SAFE_TO_APPLY") {
    throw new Error("Blocked: public application objects have an unexpected owner");
  }
}

async function assertCanonicalPostcondition(client: PoolClient): Promise<void> {
  const owned = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = ANY($1::"char"[])
        AND pg_get_userbyid(c.relowner) <> $2`,
    [RELATION_KINDS, MIGRATOR_ROLE],
  );
  if (owned.rows[0]?.count !== "0")
    throw new Error("Postcondition failed: migrator does not own public application objects");
  const runtime = await client.query<{ runtime_can_create: boolean }>(
    "SELECT has_schema_privilege($1, 'public', 'CREATE') AS runtime_can_create",
    [RUNTIME_ROLE],
  );
  if (runtime.rows[0]?.runtime_can_create) {
    throw new Error("Postcondition failed: runtime retains CREATE on public");
  }
}

export async function transitionLegacyPostgresRoles(
  client: PoolClient,
  mode: Mode,
  ownerDatabaseUrl: string,
  apply: {
    readonly migratorDatabaseUrl: string;
    readonly migratorPassword: string;
    readonly runtimePassword: string;
  } | null,
  psql: PsqlRunner = runPsql,
): Promise<TransitionReport> {
  const expectedDatabase = databaseName(ownerDatabaseUrl);
  const before = await inspect(client, expectedDatabase);
  assertSafe(before.report);
  if (mode === "dry-run") return before.report;
  if (apply === null) throw new Error("--apply requires migrator and runtime role credentials");
  if (databaseName(apply.migratorDatabaseUrl) !== expectedDatabase) {
    throw new Error("Blocked: MIGRATOR_DATABASE_URL targets a different database");
  }
  if (new URL(apply.migratorDatabaseUrl).username !== MIGRATOR_ROLE) {
    throw new Error("Blocked: MIGRATOR_DATABASE_URL must authenticate as pokemon_migrator");
  }
  if (decodeURIComponent(new URL(apply.migratorDatabaseUrl).password) !== apply.migratorPassword) {
    throw new Error("Blocked: MIGRATOR_PASSWORD must match MIGRATOR_DATABASE_URL");
  }

  await psql({
    connectionString: ownerDatabaseUrl,
    script: "roles.sql",
    variables: {
      migrator_role: MIGRATOR_ROLE,
      migrator_password: apply.migratorPassword,
      runtime_role: RUNTIME_ROLE,
      runtime_password: apply.runtimePassword,
    },
  });
  const current = await inspect(client, expectedDatabase);
  assertSafe(current.report);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    for (const relation of current.relations) {
      if (relation.owner !== "postgres") continue;
      await client.query(
        `ALTER ${commandFor(relation.relkind)} public.${quoteIdentifier(relation.relname)} OWNER TO ${quoteIdentifier(MIGRATOR_ROLE)}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  await psql({
    connectionString: apply.migratorDatabaseUrl,
    script: "runtime_grants.sql",
    variables: { migrator_role: MIGRATOR_ROLE, runtime_role: RUNTIME_ROLE },
  });
  await assertCanonicalPostcondition(client);
  return (await inspect(client, expectedDatabase)).report;
}

function printReport(report: TransitionReport): void {
  process.stdout.write(`decision=${report.decision}\n`);
  process.stdout.write(
    `roles=${MIGRATOR_ROLE}:${report.roles[MIGRATOR_ROLE]},${RUNTIME_ROLE}:${report.roles[RUNTIME_ROLE]}\n`,
  );
  process.stdout.write(
    `transfer_counts=tables:${report.transferCounts.r},partitioned_tables:${report.transferCounts.p},sequences:${report.transferCounts.S},views:${report.transferCounts.v},materialized_views:${report.transferCounts.m}\n`,
  );
  process.stdout.write(`unexpected_owners=${report.unexpectedOwnerCount}\n`);
  process.stdout.write(`grants_to_reconcile=${report.grantsToReconcile.join(",")}\n`);
}

async function main(): Promise<void> {
  const mode = transitionMode(process.argv.slice(2), process.env);
  const ownerDatabaseUrl = process.env.DATABASE_URL;
  if (ownerDatabaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const apply =
    mode === "dry-run"
      ? null
      : {
          migratorDatabaseUrl: requireEnvironment("MIGRATOR_DATABASE_URL"),
          migratorPassword: requireEnvironment("MIGRATOR_PASSWORD"),
          runtimePassword: requireEnvironment("RUNTIME_PASSWORD"),
        };
  const pool = new Pool({
    connectionString: ownerDatabaseUrl,
    application_name: "pokemon-rpg-legacy-role-transition",
    max: 1,
  });
  const client = await pool.connect();
  try {
    printReport(await transitionLegacyPostgresRoles(client, mode, ownerDatabaseUrl, apply));
  } finally {
    client.release();
    await pool.end();
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required for --apply`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
