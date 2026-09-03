import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { OWNER_SECURITY_ADMIN_ROLE } from "../../modules/admin/registry-catalog.js";
import { withTransaction } from "../db/transaction.js";
import { reconcileCanonicalAdminRegistry } from "./postgres-admin-registry-seed.js";

export const LOCAL_ADMIN_IDENTITY_REF = "local-development:control-center-owner";

export interface LocalAdminBootstrapResult {
  readonly principalId: string;
  readonly roleSlug: typeof OWNER_SECURITY_ADMIN_ROLE;
  readonly replayed: boolean;
}

export class LocalAdminBootstrapConflictError extends Error {
  override readonly name = "LocalAdminBootstrapConflictError";
}

export async function bootstrapLocalAdmin(pool: Pool): Promise<LocalAdminBootstrapResult> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('pokemon-rpg:local-admin-bootstrap', 0))",
    );

    const registry = await reconcileCanonicalAdminRegistry(client);
    const existing = await client.query<{ id: string; status: "ACTIVE" | "DISABLED" }>(
      `SELECT id, status
       FROM admin_principals
       WHERE identity_ref = $1
       FOR UPDATE`,
      [LOCAL_ADMIN_IDENTITY_REF],
    );
    const row = existing.rows[0];
    if (row?.status === "DISABLED") {
      throw new LocalAdminBootstrapConflictError(
        "Local admin principal is disabled and must not be silently reactivated",
      );
    }

    const principalId = row?.id ?? randomUUID();
    if (row === undefined) {
      await client.query(
        `INSERT INTO admin_principals(id, identity_ref, status)
         VALUES ($1, $2, 'ACTIVE')`,
        [principalId, LOCAL_ADMIN_IDENTITY_REF],
      );
    }

    await client.query("DELETE FROM admin_principal_roles WHERE principal_id = $1", [principalId]);
    await client.query(
      `INSERT INTO admin_principal_roles(principal_id, role_id)
       VALUES ($1, $2)`,
      [principalId, registry.ownerRoleId],
    );

    await client.query("DELETE FROM admin_principal_scopes WHERE principal_id = $1", [principalId]);
    await client.query(
      `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
       VALUES ($1, $2, 'GLOBAL', NULL)`,
      [randomUUID(), principalId],
    );

    return {
      principalId,
      roleSlug: OWNER_SECURITY_ADMIN_ROLE,
      replayed: row !== undefined,
    };
  });
}
