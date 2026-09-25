import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const [adminCounts, ownerCounts, centralView, overrides, previewRefs, reception] =
      await Promise.all([
        pool.query<{ active_admins: number }>(
          `SELECT count(*)::int AS active_admins
           FROM admin_principals
           WHERE status = 'ACTIVE'`,
        ),
        pool.query<{ protected_owners: number }>(
          `SELECT count(DISTINCT principal.id)::int AS protected_owners
           FROM admin_principals principal
           JOIN admin_principal_roles relation ON relation.principal_id = principal.id
           JOIN admin_roles role ON role.id = relation.role_id
           WHERE principal.status = 'ACTIVE'
             AND role.slug = 'OWNER_SECURITY_ADMIN'`,
        ),
        pool.query<{ capability_exists: boolean; effective_admins: number }>(
          `SELECT
             EXISTS(SELECT 1 FROM capabilities WHERE key = 'central.view') AS capability_exists,
             CASE
               WHEN to_regclass('public.admin_effective_capabilities') IS NULL THEN 0
               ELSE (
                 SELECT count(DISTINCT principal_id)::int
                 FROM admin_effective_capabilities
                 WHERE key = 'central.view'
               )
             END AS effective_admins`,
        ),
        pool.query<{ table_exists: boolean }>(
          `SELECT to_regclass('public.admin_principal_capability_overrides') IS NOT NULL AS table_exists`,
        ),
        pool.query<{ table_exists: boolean }>(
          `SELECT to_regclass('public.admin_batch_whatsapp_preview_refs') IS NOT NULL AS table_exists`,
        ),
        pool.query<{
          reception_groups: number;
          assigned_staff: number;
          mention_eligible_staff: number;
        }>(
          `SELECT
             (SELECT count(*)::int
              FROM community_groups
              WHERE role = 'RECEPTION' AND status = 'ACTIVE') AS reception_groups,
             (SELECT count(*)::int
              FROM reception_staff_assignments assignment
              JOIN community_groups community ON community.id = assignment.group_id
              WHERE community.role = 'RECEPTION'
                AND community.status = 'ACTIVE'
                AND assignment.active = TRUE) AS assigned_staff,
             CASE
               WHEN to_regclass('public.admin_effective_capabilities') IS NULL THEN 0
               ELSE (
                 SELECT count(DISTINCT principal.id)::int
                 FROM reception_staff_assignments assignment
                 JOIN community_groups community ON community.id = assignment.group_id
                 JOIN admin_principals principal ON principal.id = assignment.admin_principal_id
                 JOIN admin_effective_capabilities effective ON effective.principal_id = principal.id
                 WHERE community.role = 'RECEPTION'
                   AND community.status = 'ACTIVE'
                   AND assignment.active = TRUE
                   AND principal.status = 'ACTIVE'
                   AND principal.identity_ref LIKE 'whatsapp:%'
                   AND effective.key = 'player.registration.read'
               )
             END AS mention_eligible_staff`,
        ),
      ]);

    console.log("ADMIN_OPENING_READINESS_V1");
    console.log(`activeAdminCount=${adminCounts.rows[0]?.active_admins ?? 0}`);
    console.log(`protectedOwnerCount=${ownerCounts.rows[0]?.protected_owners ?? 0}`);
    console.log(`centralViewCapabilityExists=${centralView.rows[0]?.capability_exists ?? false}`);
    console.log(`centralViewEffectiveAdminCount=${centralView.rows[0]?.effective_admins ?? 0}`);
    console.log(`capabilityOverridesTableExists=${overrides.rows[0]?.table_exists ?? false}`);
    console.log(`adminBatchWhatsAppPreviewRefsTableExists=${previewRefs.rows[0]?.table_exists ?? false}`);
    console.log(`activeReceptionGroupCount=${reception.rows[0]?.reception_groups ?? 0}`);
    console.log(`activeReceptionStaffAssignmentCount=${reception.rows[0]?.assigned_staff ?? 0}`);
    console.log(`mentionEligibleReceptionStaffCount=${reception.rows[0]?.mention_eligible_staff ?? 0}`);

    const ownersReady = (ownerCounts.rows[0]?.protected_owners ?? 0) === 2;
    const permissionsReady =
      centralView.rows[0]?.capability_exists === true &&
      overrides.rows[0]?.table_exists === true &&
      previewRefs.rows[0]?.table_exists === true;
    const mentionsReady =
      (reception.rows[0]?.reception_groups ?? 0) > 0 &&
      (reception.rows[0]?.assigned_staff ?? 0) > 0 &&
      (reception.rows[0]?.mention_eligible_staff ?? 0) > 0;

    console.log(`ownersReady=${ownersReady}`);
    console.log(`permissionsSchemaReady=${permissionsReady}`);
    console.log(`registrationMentionsReady=${mentionsReady}`);
  } finally {
    await pool.end();
  }
}

await main();
