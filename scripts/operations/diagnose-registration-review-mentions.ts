import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required");
}

interface GroupRow {
  readonly display_name: string;
  readonly status: string;
  readonly has_admin_review: boolean;
  readonly assigned_staff: number;
  readonly active_admin_staff: number;
  readonly registration_read_staff: number;
  readonly whatsapp_identity_staff: number;
  readonly mention_eligible_staff: number;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await pool.query<GroupRow>(
      `SELECT
         community.display_name,
         community.status,
         EXISTS (
           SELECT 1
           FROM community_group_capabilities capability
           WHERE capability.group_id = community.id
             AND capability.capability_key = 'admin.review'
             AND capability.active = TRUE
         ) AS has_admin_review,
         (
           SELECT count(*)::int
           FROM reception_staff_assignments assignment
           WHERE assignment.group_id = community.id
             AND assignment.active = TRUE
         ) AS assigned_staff,
         (
           SELECT count(DISTINCT principal.id)::int
           FROM reception_staff_assignments assignment
           JOIN admin_principals principal
             ON principal.id = assignment.admin_principal_id
            AND principal.status = 'ACTIVE'
           WHERE assignment.group_id = community.id
             AND assignment.active = TRUE
         ) AS active_admin_staff,
         (
           SELECT count(DISTINCT principal.id)::int
           FROM reception_staff_assignments assignment
           JOIN admin_principals principal
             ON principal.id = assignment.admin_principal_id
            AND principal.status = 'ACTIVE'
           JOIN admin_principal_roles principal_role
             ON principal_role.principal_id = principal.id
           JOIN admin_role_capabilities role_capability
             ON role_capability.role_id = principal_role.role_id
           JOIN capabilities capability
             ON capability.id = role_capability.capability_id
            AND capability.key = 'player.registration.read'
           WHERE assignment.group_id = community.id
             AND assignment.active = TRUE
         ) AS registration_read_staff,
         (
           SELECT count(DISTINCT principal.id)::int
           FROM reception_staff_assignments assignment
           JOIN admin_principals principal
             ON principal.id = assignment.admin_principal_id
            AND principal.status = 'ACTIVE'
           WHERE assignment.group_id = community.id
             AND assignment.active = TRUE
             AND principal.identity_ref LIKE 'whatsapp:%'
             AND length(principal.identity_ref) > 9
         ) AS whatsapp_identity_staff,
         (
           SELECT count(DISTINCT principal.id)::int
           FROM reception_staff_assignments assignment
           JOIN admin_principals principal
             ON principal.id = assignment.admin_principal_id
            AND principal.status = 'ACTIVE'
           JOIN admin_principal_roles principal_role
             ON principal_role.principal_id = principal.id
           JOIN admin_role_capabilities role_capability
             ON role_capability.role_id = principal_role.role_id
           JOIN capabilities capability
             ON capability.id = role_capability.capability_id
            AND capability.key = 'player.registration.read'
           WHERE assignment.group_id = community.id
             AND assignment.active = TRUE
             AND principal.identity_ref LIKE 'whatsapp:%'
             AND length(principal.identity_ref) > 9
         ) AS mention_eligible_staff
       FROM community_groups community
       WHERE community.role = 'RECEPTION'
         AND community.status = 'ACTIVE'
       ORDER BY community.created_at, community.id`,
    );

    console.log("REGISTRATION_MENTION_DIAGNOSTIC_V1");
    console.log(`receptionGroupCount=${result.rows.length}`);
    for (const [index, row] of result.rows.entries()) {
      console.log(`group[${index + 1}].displayName=${row.display_name}`);
      console.log(`group[${index + 1}].status=${row.status}`);
      console.log(`group[${index + 1}].hasAdminReview=${row.has_admin_review}`);
      console.log(`group[${index + 1}].assignedStaff=${row.assigned_staff}`);
      console.log(`group[${index + 1}].activeAdminStaff=${row.active_admin_staff}`);
      console.log(`group[${index + 1}].registrationReadStaff=${row.registration_read_staff}`);
      console.log(`group[${index + 1}].whatsappIdentityStaff=${row.whatsapp_identity_staff}`);
      console.log(`group[${index + 1}].mentionEligibleStaff=${row.mention_eligible_staff}`);
    }

    const allGreen =
      result.rows.length > 0 &&
      result.rows.every(
        (row) =>
          row.has_admin_review && row.assigned_staff > 0 && row.mention_eligible_staff > 0,
      );
    console.log(`allReceptionMentionPrerequisites=${allGreen}`);
  } finally {
    await pool.end();
  }
}

await main();
