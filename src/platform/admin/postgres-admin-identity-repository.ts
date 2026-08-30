import type { Pool } from "pg";
import type {
  AdminPrincipalIdentityRecord,
  AdminPrincipalIdentityRepository,
} from "../../adapters/admin-api/identity-resolver.js";

interface AdminPrincipalIdentityRow {
  readonly id: string;
  readonly identity_ref: string;
  readonly status: "ACTIVE" | "DISABLED";
}

export class PostgresAdminIdentityRepository implements AdminPrincipalIdentityRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByIdentityRef(identityRef: string): Promise<AdminPrincipalIdentityRecord | null> {
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
}
