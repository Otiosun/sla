import type { Pool } from "pg";
import type {
  AdminPrincipalIdentityRecord,
  AdminPrincipalIdentityRepository,
} from "../../adapters/admin-api/identity-resolver.js";
import type { AdminSessionRoleReader } from "../../adapters/admin-api/session-service.js";

interface AdminPrincipalIdentityRow {
  readonly id: string;
  readonly identity_ref: string;
  readonly status: "ACTIVE" | "DISABLED";
}

export class PostgresAdminIdentityRepository
  implements AdminPrincipalIdentityRepository, AdminSessionRoleReader
{
  public constructor(private readonly pool: Pool) {}

  public async findByIdentityRef(
    identityRef: string,
  ): Promise<AdminPrincipalIdentityRecord | null> {
    const result = await this.pool.query<AdminPrincipalIdentityRow>(
      `SELECT id, identity_ref, status
       FROM admin_principals
       WHERE identity_ref = $1`,
      [identityRef],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      principalId: row.id,
      identityRef: row.identity_ref,
      status: row.status,
    };
  }

  public async listRoleSlugs(principalId: string): Promise<readonly string[]> {
    const result = await this.pool.query<{ slug: string }>(
      `SELECT role.slug
       FROM admin_principal_roles relation
       JOIN admin_roles role ON role.id = relation.role_id
       WHERE relation.principal_id = $1
       ORDER BY role.slug`,
      [principalId],
    );
    return result.rows.map((row) => row.slug);
  }
}
