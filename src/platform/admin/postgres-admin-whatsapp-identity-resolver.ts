import type { Pool } from "pg";

export interface AdminExternalIdentityInput {
  readonly provider: string;
  readonly externalId: string;
}

function identityRef(input: AdminExternalIdentityInput): string | null {
  const provider = input.provider.trim().toLocaleLowerCase("en-US");
  const externalId = input.externalId.trim();
  if (externalId.length === 0) return null;
  if (provider !== "baileys" && provider !== "whatsapp") return null;
  return `whatsapp:${externalId}`;
}

export class PostgresAdminWhatsAppIdentityResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolvePrincipal(
    input: AdminExternalIdentityInput,
  ): Promise<{ readonly principalId: string } | null> {
    const identity = identityRef(input);
    if (identity === null) return null;

    const result = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM admin_principals
       WHERE identity_ref = $1 AND status = 'ACTIVE'`,
      [identity],
    );
    const row = result.rows[0];
    return row === undefined ? null : { principalId: row.id };
  }

  public async capabilitiesFor(input: AdminExternalIdentityInput): Promise<readonly string[]> {
    const identity = identityRef(input);
    if (identity === null) return [];

    const result = await this.pool.query<{ key: string }>(
      `SELECT DISTINCT capability.key
       FROM admin_principals principal
       JOIN admin_principal_roles principal_role ON principal_role.principal_id = principal.id
       JOIN admin_role_capabilities role_capability ON role_capability.role_id = principal_role.role_id
       JOIN capabilities capability ON capability.id = role_capability.capability_id
       WHERE principal.identity_ref = $1
         AND principal.status = 'ACTIVE'
       ORDER BY capability.key`,
      [identity],
    );
    return result.rows.map((row) => row.key);
  }

  public async whatsAppJidsForPrincipals(input: {
    readonly principalIds: readonly string[];
    readonly requiredCapability: string;
  }): Promise<readonly string[]> {
    const principalIds = [...new Set(input.principalIds.map((value) => value.trim()))].filter(
      (value) => value.length > 0,
    );
    const requiredCapability = input.requiredCapability.trim();
    if (principalIds.length === 0 || requiredCapability.length === 0) return [];

    const result = await this.pool.query<{ jid: string }>(
      `SELECT DISTINCT substring(principal.identity_ref FROM 10) AS jid
       FROM admin_principals principal
       JOIN admin_principal_roles principal_role ON principal_role.principal_id = principal.id
       JOIN admin_role_capabilities role_capability ON role_capability.role_id = principal_role.role_id
       JOIN capabilities capability ON capability.id = role_capability.capability_id
       WHERE principal.id::text = ANY($1::text[])
         AND principal.status = 'ACTIVE'
         AND principal.identity_ref LIKE 'whatsapp:%'
         AND length(principal.identity_ref) > 9
         AND capability.key = $2
       ORDER BY jid`,
      [principalIds, requiredCapability],
    );
    return result.rows.map((row) => row.jid);
  }
}
