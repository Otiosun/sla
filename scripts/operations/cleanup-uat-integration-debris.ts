import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const UAT_PRINCIPAL = "^uat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const UAT_PLAYER = "^uat-[ab]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const APPLY_CONFIRMATION = "DELETE_UAT_INTEGRATION_DEBRIS";

export const foreignKeyMetadataQuery = `SELECT namespace.nspname AS schema_name, relation.relname AS table_name, attribute.attname AS column_name
       FROM pg_constraint foreign_key
       JOIN pg_class relation ON relation.oid = foreign_key.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN LATERAL unnest(foreign_key.conkey) AS key(attnum) ON TRUE
       JOIN pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
      WHERE foreign_key.contype = 'f'
        AND foreign_key.confrelid = $1::regclass
        AND namespace.nspname = current_schema()`;

export function cleanupMode(args: readonly string[], env: NodeJS.ProcessEnv): "dry-run" | "apply" {
  if (!args.includes("--apply")) return "dry-run";
  if (env.UAT_INTEGRATION_DEBRIS_CLEANUP_CONFIRM !== APPLY_CONFIRMATION) {
    throw new Error(
      "--apply requires UAT_INTEGRATION_DEBRIS_CLEANUP_CONFIRM=DELETE_UAT_INTEGRATION_DEBRIS",
    );
  }
  return "apply";
}

async function assertNone(client: PoolClient, sql: string, label: string): Promise<void> {
  const result = await client.query<{ count: string }>(sql);
  if (result.rows[0]?.count !== "0") throw new Error(`Refusing cleanup: unexpected ${label}`);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Refuse to proceed when a target is referenced by a table this cleanup does not own. */
async function assertNoUnexpectedForeignKeys(
  client: PoolClient,
  referencedTable: "players" | "pokemon_instances" | "admin_principals",
  targetTable: string,
  allowedChildTables: readonly string[],
  label: string,
): Promise<void> {
  const foreignKeys = await client.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
  }>(foreignKeyMetadataQuery, [referencedTable]);
  for (const foreignKey of foreignKeys.rows) {
    if (allowedChildTables.includes(foreignKey.table_name)) continue;
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ${quoteIdentifier(foreignKey.schema_name)}.${quoteIdentifier(foreignKey.table_name)} child
         JOIN ${quoteIdentifier(targetTable)} target ON child.${quoteIdentifier(foreignKey.column_name)} = target.id`,
    );
    if (result.rows[0]?.count !== "0") {
      throw new Error(
        `Refusing cleanup: unexpected ${label} reference in ${foreignKey.table_name}`,
      );
    }
  }
}

async function preview(client: PoolClient): Promise<void> {
  const tables = [
    ["player_party_members", "party_id IN (SELECT party_id FROM cleanup_parties)"],
    ["player_parties", "id IN (SELECT party_id FROM cleanup_parties)"],
    ["player_uat_bootstraps", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_access", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_area_visits", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_locations", "player_id IN (SELECT id FROM cleanup_players)"],
    ["starter_grants", "player_id IN (SELECT id FROM cleanup_players)"],
    ["pokemon_history_events", "pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)"],
    ["pokemon_roster_slots", "pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)"],
    ["pokemon_move_slots", "pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)"],
    ["pokemon_training_values", "pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)"],
    ["pokemon_persistent_conditions", "pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)"],
    ["pokemon_instances", "id IN (SELECT id FROM cleanup_pokemon)"],
    ["player_pokedex_species", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_profiles", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_onboarding_context", "player_id IN (SELECT id FROM cleanup_players)"],
    ["onboarding_states", "player_id IN (SELECT id FROM cleanup_players)"],
    ["trainer_progression", "player_id IN (SELECT id FROM cleanup_players)"],
    ["player_identities", "player_id IN (SELECT id FROM cleanup_players)"],
    ["players", "id IN (SELECT id FROM cleanup_players)"],
    ["admin_principals", "id IN (SELECT id FROM cleanup_principals)"],
  ] as const;
  for (const [table, where] of tables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    );
    process.stdout.write(`${table}=${result.rows[0]?.count ?? "0"}\n`);
  }
}

export async function cleanupUatIntegrationDebris(
  client: PoolClient,
  mode: "dry-run" | "apply",
): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      `CREATE TEMP TABLE cleanup_principals ON COMMIT DROP AS
      SELECT id FROM admin_principals WHERE identity_ref ~ $1 FOR UPDATE`,
      [UAT_PRINCIPAL],
    );
    await assertNone(
      client,
      `SELECT count(*)::text AS count FROM admin_principals WHERE identity_ref LIKE 'uat:%' AND identity_ref !~ '${UAT_PRINCIPAL}'`,
      "noncanonical UAT principal identity",
    );
    await client.query(
      `CREATE TEMP TABLE cleanup_players ON COMMIT DROP AS
      SELECT player.id FROM players player JOIN player_identities identity ON identity.player_id=player.id
      WHERE identity.external_id ~ $1 FOR UPDATE OF player, identity`,
      [UAT_PLAYER],
    );
    await assertNone(
      client,
      `SELECT count(*)::text AS count FROM player_identities WHERE (external_id LIKE 'uat-a-%' OR external_id LIKE 'uat-b-%') AND external_id !~ '${UAT_PLAYER}'`,
      "noncanonical UAT player identity",
    );
    await assertNone(
      client,
      `SELECT count(*)::text AS count FROM cleanup_players player WHERE (SELECT count(*) FROM player_identities identity WHERE identity.player_id=player.id) <> 1 OR EXISTS (SELECT 1 FROM player_identities identity WHERE identity.player_id=player.id AND identity.external_id !~ '${UAT_PLAYER}')`,
      "additional player identity",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM cleanup_players player WHERE NOT EXISTS (SELECT 1 FROM player_uat_bootstraps bootstrap WHERE bootstrap.player_id=player.id)",
      "player without a UAT bootstrap marker",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM admin_principal_roles WHERE principal_id IN (SELECT id FROM cleanup_principals)",
      "principal role",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM admin_principal_scopes WHERE principal_id IN (SELECT id FROM cleanup_principals)",
      "principal scope",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM admin_initial_bootstrap_state WHERE principal_id IN (SELECT id FROM cleanup_principals)",
      "bootstrap marker",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM admin_operations WHERE principal_id IN (SELECT id FROM cleanup_principals)",
      "admin operation",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_uat_bootstraps WHERE player_id IN (SELECT id FROM cleanup_players) AND bootstrapped_by NOT IN (SELECT id FROM cleanup_principals)",
      "external UAT bootstrap principal",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_uat_bootstraps WHERE bootstrapped_by IN (SELECT id FROM cleanup_principals) AND player_id NOT IN (SELECT id FROM cleanup_players)",
      "UAT principal bootstrap for an external player",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM starter_grants WHERE player_id IN (SELECT id FROM cleanup_players) AND pokemon_instance_id NOT IN (SELECT id FROM pokemon_instances WHERE owner_player_id IN (SELECT id FROM cleanup_players))",
      "starter grant for an external Pokémon",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_access WHERE player_id IN (SELECT id FROM cleanup_players) AND suspended_by IS NOT NULL",
      "player access modified by an administrator",
    );
    await client.query(
      "SELECT 1 FROM player_party_members WHERE player_id IN (SELECT id FROM cleanup_players) FOR UPDATE",
    );
    await client.query(`CREATE TEMP TABLE cleanup_parties ON COMMIT DROP AS
      SELECT DISTINCT party_id FROM player_party_members WHERE player_id IN (SELECT id FROM cleanup_players)`);
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_party_members WHERE party_id IN (SELECT party_id FROM cleanup_parties) AND player_id NOT IN (SELECT id FROM cleanup_players)",
      "mixed party",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_parties WHERE id IN (SELECT party_id FROM cleanup_parties) AND leader_player_id NOT IN (SELECT id FROM cleanup_players)",
      "external party leader",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_parties WHERE leader_player_id IN (SELECT id FROM cleanup_players) AND id NOT IN (SELECT party_id FROM cleanup_parties)",
      "party without a target member",
    );
    await client.query(
      "CREATE TEMP TABLE cleanup_pokemon ON COMMIT DROP AS SELECT id FROM pokemon_instances WHERE owner_player_id IN (SELECT id FROM cleanup_players) FOR UPDATE",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM audit_events WHERE actor_id::text IN (SELECT id::text FROM cleanup_principals) OR target_id::text IN (SELECT id::text FROM cleanup_principals UNION SELECT id::text FROM cleanup_players UNION SELECT id::text FROM cleanup_pokemon)",
      "admin, player, or Pokémon audit",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM starter_grants WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon) AND player_id NOT IN (SELECT id FROM cleanup_players)",
      "external player starter grant",
    );
    await assertNoUnexpectedForeignKeys(
      client,
      "admin_principals",
      "cleanup_principals",
      [
        "admin_principal_roles",
        "admin_principal_scopes",
        "admin_initial_bootstrap_state",
        "admin_operations",
        "player_uat_bootstraps",
        "reception_staff_assignments",
      ],
      "principal",
    );
    await assertNoUnexpectedForeignKeys(
      client,
      "players",
      "cleanup_players",
      [
        "player_identities",
        "player_profiles",
        "onboarding_states",
        "trainer_progression",
        "player_onboarding_context",
        "starter_grants",
        "pokemon_instances",
        "player_access",
        "player_area_visits",
        "player_locations",
        "player_uat_bootstraps",
        "player_party_members",
        "player_parties",
        "player_pokedex_species",
      ],
      "player",
    );
    await assertNoUnexpectedForeignKeys(
      client,
      "pokemon_instances",
      "cleanup_pokemon",
      [
        "pokemon_training_values",
        "pokemon_move_slots",
        "pokemon_roster_slots",
        "pokemon_persistent_conditions",
        "pokemon_history_events",
        "starter_grants",
      ],
      "Pokémon",
    );
    await preview(client);
    if (mode === "dry-run") {
      await client.query("ROLLBACK");
      return;
    }
    for (const sql of [
      "DELETE FROM player_party_members WHERE party_id IN (SELECT party_id FROM cleanup_parties)",
      "DELETE FROM player_parties WHERE id IN (SELECT party_id FROM cleanup_parties)",
      "DELETE FROM player_uat_bootstraps WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_access WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_area_visits WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_locations WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM starter_grants WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM pokemon_history_events WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM pokemon_roster_slots WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM pokemon_move_slots WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM pokemon_training_values WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM pokemon_persistent_conditions WHERE pokemon_instance_id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM pokemon_instances WHERE id IN (SELECT id FROM cleanup_pokemon)",
      "DELETE FROM player_pokedex_species WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_profiles WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_onboarding_context WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM onboarding_states WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM trainer_progression WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM player_identities WHERE player_id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM players WHERE id IN (SELECT id FROM cleanup_players)",
      "DELETE FROM admin_principals WHERE id IN (SELECT id FROM cleanup_principals)",
    ])
      await client.query(sql);
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM admin_principals WHERE identity_ref ~ '" +
        UAT_PRINCIPAL +
        "'",
      "remaining principal",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_identities WHERE external_id ~ '" +
        UAT_PLAYER +
        "'",
      "remaining player identity",
    );
    await assertNone(
      client,
      "SELECT count(*)::text AS count FROM player_uat_bootstraps WHERE bootstrapped_by IN (SELECT id FROM cleanup_principals)",
      "remaining UAT bootstrap marker",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = cleanupMode(process.argv.slice(2), process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "pokemon-rpg-uat-debris-cleanup",
    max: 1,
  });
  const client = await pool.connect();
  try {
    await cleanupUatIntegrationDebris(client, mode);
  } finally {
    client.release();
    await pool.end();
  }
}
