import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLE_CAPABILITIES,
  OWNER_SECURITY_ADMIN_ROLE,
} from "../../modules/admin/registry-catalog.js";

export interface AdminRegistryReconciliationResult {
  readonly ownerRoleId: string;
  readonly capabilityCount: number;
  readonly roleCount: number;
}

export async function reconcileCanonicalAdminRegistry(
  client: PoolClient,
): Promise<AdminRegistryReconciliationResult> {
  for (const [key, riskTier] of ADMIN_CAPABILITIES) {
    await client.query(
      `INSERT INTO capabilities(id, key, risk_tier)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [randomUUID(), key, riskTier],
    );
    const persisted = await client.query<{ risk_tier: number }>(
      `SELECT risk_tier FROM capabilities WHERE key = $1`,
      [key],
    );
    if (persisted.rows[0]?.risk_tier !== riskTier) {
      throw new Error(`Canonical admin capability risk drift detected for ${key}`);
    }
  }

  let ownerRoleId: string | null = null;
  for (const [slug, capabilityKeys] of Object.entries(ADMIN_ROLE_CAPABILITIES)) {
    await client.query(
      `INSERT INTO admin_roles(id, slug, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [randomUUID(), slug, slug.replaceAll("_", " ")],
    );
    const role = await client.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE slug = $1`,
      [slug],
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error(`Canonical admin role missing after reconciliation: ${slug}`);

    await client.query(
      `DELETE FROM admin_role_capabilities relation
       USING capabilities capability
       WHERE relation.role_id = $1
         AND relation.capability_id = capability.id
         AND NOT (capability.key = ANY($2::text[]))`,
      [roleId, capabilityKeys],
    );
    for (const capabilityKey of capabilityKeys) {
      const inserted = await client.query(
        `INSERT INTO admin_role_capabilities(role_id, capability_id)
         SELECT $1, capability.id
         FROM capabilities capability
         WHERE capability.key = $2
         ON CONFLICT DO NOTHING`,
        [roleId, capabilityKey],
      );
      if (inserted.rowCount !== 1) {
        const existing = await client.query(
          `SELECT 1
           FROM admin_role_capabilities relation
           JOIN capabilities capability ON capability.id = relation.capability_id
           WHERE relation.role_id = $1 AND capability.key = $2`,
          [roleId, capabilityKey],
        );
        if (existing.rowCount !== 1) {
          throw new Error(`Canonical admin role capability missing: ${slug}/${capabilityKey}`);
        }
      }
    }

    const actual = await client.query<{ key: string }>(
      `SELECT capability.key
       FROM admin_role_capabilities relation
       JOIN capabilities capability ON capability.id = relation.capability_id
       WHERE relation.role_id = $1
       ORDER BY capability.key`,
      [roleId],
    );
    const expected = [...capabilityKeys].sort();
    const actualKeys = actual.rows.map((row) => row.key);
    if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
      throw new Error(`Canonical admin role capability drift remains after reconciliation: ${slug}`);
    }
    if (slug === OWNER_SECURITY_ADMIN_ROLE) ownerRoleId = roleId;
  }

  if (ownerRoleId === null) throw new Error("Canonical owner/security admin role is missing");
  return {
    ownerRoleId,
    capabilityCount: ADMIN_CAPABILITIES.length,
    roleCount: Object.keys(ADMIN_ROLE_CAPABILITIES).length,
  };
}
