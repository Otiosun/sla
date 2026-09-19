import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { reconcileCanonicalAdminRegistry } from "../../src/platform/admin/postgres-admin-registry-seed.js";
import { withTransaction } from "../../src/platform/db/transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const RECEPTION_CHAT = "120363900000000001@g.us";
const WORLD_CHAT = "120363900000000002@g.us";
const ADMIN_JID = "5599999999000@s.whatsapp.net";

async function ensurePrincipal(client: PoolClient, ownerRoleId: string): Promise<string> {
  const identityRef = `whatsapp:${ADMIN_JID}`;
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM admin_principals WHERE identity_ref=$1",
    [identityRef],
  );
  const principalId = existing.rows[0]?.id ?? randomUUID();

  if (existing.rows[0] === undefined) {
    await client.query(
      "INSERT INTO admin_principals(id,identity_ref,status) VALUES ($1,$2,'ACTIVE')",
      [principalId, identityRef],
    );
  } else {
    await client.query("UPDATE admin_principals SET status='ACTIVE' WHERE id=$1", [principalId]);
  }

  await client.query(
    "INSERT INTO admin_principal_roles(principal_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [principalId, ownerRoleId],
  );
  await client.query(
    `INSERT INTO admin_principal_scopes(id,principal_id,scope_type,scope_id)
     SELECT $1,$2,'GLOBAL',NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM admin_principal_scopes
       WHERE principal_id=$2 AND scope_type='GLOBAL' AND scope_id IS NULL AND status='ACTIVE'
     )`,
    [randomUUID(), principalId],
  );
  return principalId;
}

async function ensureGroup(
  client: PoolClient,
  input: {
    readonly chatRef: string;
    readonly role: "RECEPTION" | "GAME";
    readonly displayName: string;
    readonly capabilities: readonly string[];
  },
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM community_groups WHERE provider='baileys' AND chat_ref=$1",
    [input.chatRef],
  );
  const groupId = existing.rows[0]?.id ?? randomUUID();

  if (existing.rows[0] === undefined) {
    await client.query(
      `INSERT INTO community_groups(id,provider,chat_ref,role,display_name,status)
       VALUES ($1,'baileys',$2,$3,$4,'ACTIVE')`,
      [groupId, input.chatRef, input.role, input.displayName],
    );
  } else {
    await client.query(
      `UPDATE community_groups
       SET role=$2,display_name=$3,status='ACTIVE',revision=revision+1,updated_at=now()
       WHERE id=$1`,
      [groupId, input.role, input.displayName],
    );
  }

  for (const capability of input.capabilities) {
    await client.query(
      `INSERT INTO community_group_capabilities(group_id,capability_key,active)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (group_id,capability_key)
       DO UPDATE SET active=TRUE`,
      [groupId, capability],
    );
  }

  return groupId;
}

async function assertPlayableContent(pool: Pool): Promise<void> {
  const content = await pool.query<{
    release_no: string;
    release_name: string;
    regions: string[];
    starter_count: string;
    starting_area_count: string;
  }>(
    `SELECT
       release.release_no::text AS release_no,
       release.name AS release_name,
       ARRAY(
         SELECT region.slug
         FROM region_revisions rr
         JOIN regions region ON region.id=rr.region_id
         WHERE rr.content_release_id=release.id AND rr.active=TRUE
         ORDER BY region.slug
       ) AS regions,
       (
         SELECT count(*)::text
         FROM starter_options starter
         WHERE starter.content_release_id=release.id AND starter.active=TRUE
       ) AS starter_count,
       (
         SELECT count(*)::text
         FROM area_revisions area
         JOIN areas identity ON identity.id=area.area_id
         JOIN regions region ON region.id=identity.region_id
         WHERE area.content_release_id=release.id
           AND area.active=TRUE
           AND area.starting_area=TRUE
           AND region.slug='zhoulia'
       ) AS starting_area_count
     FROM content_release_pointers pointer
     JOIN content_releases release ON release.id=pointer.content_release_id
     WHERE pointer.pointer_key='ACTIVE'`,
  );
  const row = content.rows[0];
  if (
    row === undefined ||
    row.regions.length !== 1 ||
    row.regions[0] !== "zhoulia" ||
    Number(row.starter_count) < 1 ||
    Number(row.starting_area_count) < 1
  ) {
    throw new Error(`Simulator content is not playable Zhoulia: ${JSON.stringify(row)}`);
  }
  console.log(
    `[sim-fixture] release=${row.release_no} | ${row.release_name} | regions=${row.regions.join(",")} | starters=${row.starter_count}`,
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
try {
  await assertPlayableContent(pool);
  const result = await withTransaction(pool, async (client) => {
    const registry = await reconcileCanonicalAdminRegistry(client);
    const adminPrincipalId = await ensurePrincipal(client, registry.ownerRoleId);

    const receptionGroupId = await ensureGroup(client, {
      chatRef: RECEPTION_CHAT,
      role: "RECEPTION",
      displayName: "Recepcao Simulada",
      capabilities: ["admin.review", "onboarding", "player.basic", "pve", "pvp", "world"],
    });
    const worldGroupId = await ensureGroup(client, {
      chatRef: WORLD_CHAT,
      role: "GAME",
      displayName: "Mundo Simulado",
      capabilities: ["player.basic", "pve", "pvp", "world"],
    });

    await client.query(
      `INSERT INTO reception_staff_assignments(group_id,admin_principal_id,active)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (group_id,admin_principal_id)
       DO UPDATE SET active=TRUE`,
      [receptionGroupId, adminPrincipalId],
    );

    return { adminPrincipalId, receptionGroupId, worldGroupId };
  });

  console.log("[sim-fixture] ready");
  console.log(`[sim-fixture] admin=${ADMIN_JID}`);
  console.log(`[sim-fixture] reception=${RECEPTION_CHAT}`);
  console.log(`[sim-fixture] world=${WORLD_CHAT}`);
  console.log(`[sim-fixture] adminPrincipalId=${result.adminPrincipalId}`);
  console.log(`[sim-fixture] receptionGroupId=${result.receptionGroupId}`);
  console.log(`[sim-fixture] worldGroupId=${result.worldGroupId}`);
} finally {
  await pool.end();
}
