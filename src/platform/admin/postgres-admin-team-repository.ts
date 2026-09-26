import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { AdminTeamPrincipalView } from "../../modules/admin/team-contracts.js";
import type { AdminTeamRepository } from "../../modules/admin/team-ports.js";
import { withTransaction } from "../db/transaction.js";

interface PrincipalRow {
  readonly principal_id: string;
  readonly display_name: string | null;
  readonly status: "ACTIVE" | "DISABLED";
  readonly revision: string;
  readonly owner: boolean;
  readonly reception_staff: boolean;
  readonly capabilities: string[] | null;
}

function principalView(row: PrincipalRow): AdminTeamPrincipalView {
  return {
    principalId: row.principal_id,
    displayName: row.display_name?.trim() || "Administrador",
    status: row.status,
    owner: row.owner,
    receptionStaff: row.reception_staff,
    revision: row.revision,
    capabilities: row.capabilities ?? [],
  };
}

const PRINCIPAL_SELECT = `
  SELECT principal.id AS principal_id,
         profile.trainer_name AS display_name,
         principal.status,
         principal.revision::text,
         EXISTS (
           SELECT 1
           FROM admin_principal_roles owner_relation
           JOIN admin_roles owner_role ON owner_role.id = owner_relation.role_id
           WHERE owner_relation.principal_id = principal.id
             AND owner_role.slug = 'OWNER_SECURITY_ADMIN'
         ) AS owner,
         EXISTS (
           SELECT 1
           FROM reception_staff_assignments assignment
           JOIN community_groups reception ON reception.id = assignment.group_id
           WHERE assignment.admin_principal_id = principal.id
             AND assignment.active = TRUE
             AND reception.role = 'RECEPTION'
             AND reception.status = 'ACTIVE'
         ) AS reception_staff,
         COALESCE(
           (
             SELECT array_agg(effective.key ORDER BY effective.key)
             FROM admin_effective_capabilities effective
             WHERE effective.principal_id = principal.id
               AND effective.key <> 'UAT_BOOTSTRAP'
           ),
           ARRAY[]::text[]
         ) AS capabilities
  FROM admin_principals principal
  LEFT JOIN LATERAL (
    SELECT player_profile.trainer_name
    FROM player_identities identity
    JOIN player_profiles player_profile ON player_profile.player_id = identity.player_id
    WHERE principal.identity_ref = 'whatsapp:' || identity.external_id
      AND identity.provider IN ('baileys', 'whatsapp')
      AND identity.status = 'ACTIVE'
    ORDER BY identity.created_at
    LIMIT 1
  ) profile ON TRUE
`;

export class PostgresAdminTeamRepository implements AdminTeamRepository {
  public constructor(private readonly pool: Pool) {}

  public async isOwner(principalId: string): Promise<boolean> {
    const result = await this.pool.query<{ owner: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM admin_principal_roles relation
         JOIN admin_roles role ON role.id = relation.role_id
         WHERE relation.principal_id = $1
           AND role.slug = 'OWNER_SECURITY_ADMIN'
       ) AS owner`,
      [principalId],
    );
    return result.rows[0]?.owner === true;
  }

  public async listPrincipals(): Promise<readonly AdminTeamPrincipalView[]> {
    const result = await this.pool.query<PrincipalRow>(
      `${PRINCIPAL_SELECT}
       ORDER BY owner DESC, lower(COALESCE(profile.trainer_name, '')), principal.created_at, principal.id`,
    );
    return result.rows.map(principalView);
  }

  public async listCapabilityCatalog(): Promise<readonly { key: string; riskTier: number }[]> {
    const result = await this.pool.query<{ key: string; risk_tier: number }>(
      `SELECT key, risk_tier
       FROM capabilities
       WHERE key <> 'UAT_BOOTSTRAP'
       ORDER BY risk_tier, key`,
    );
    return result.rows.map((row) => ({ key: row.key, riskTier: row.risk_tier }));
  }

  public async addPrincipal(input: {
    readonly actorPrincipalId: string;
    readonly playerId: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
    readonly receptionStaff: boolean;
  }): Promise<AdminTeamPrincipalView> {
    return withTransaction(this.pool, async (client) => {
      const actorOwner = await client.query<{ owner: boolean }>(
        \`SELECT EXISTS (
           SELECT 1
           FROM admin_principal_roles relation
           JOIN admin_roles role ON role.id = relation.role_id
           WHERE relation.principal_id = $1
             AND role.slug = 'OWNER_SECURITY_ADMIN'
         ) AS owner\`,
        [input.actorPrincipalId],
      );
      if (actorOwner.rows[0]?.owner !== true) {
        throw new AdminError(
          ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
          "Only protected owners can add administrators",
        );
      }

      const player = await client.query<{
        trainer_name: string;
        external_id: string;
      }>(
        \`SELECT profile.trainer_name, identity.external_id
         FROM players player
         JOIN player_access access
           ON access.player_id = player.id
          AND access.status IN ('ACTIVE', 'SUSPENDED')
         JOIN player_profiles profile ON profile.player_id = player.id
         JOIN LATERAL (
           SELECT candidate.external_id
           FROM player_identities candidate
           WHERE candidate.player_id = player.id
             AND candidate.status = 'ACTIVE'
             AND lower(candidate.provider) IN ('baileys', 'whatsapp')
           ORDER BY candidate.created_at, candidate.id
           LIMIT 1
         ) identity ON TRUE
         WHERE player.id = $1
           AND player.status <> 'ARCHIVED'\`,
        [input.playerId],
      );
      const playerRow = player.rows[0];
      if (playerRow === undefined) {
        throw new AdminError(
          ADMIN_ERROR_CODES.TARGET_NOT_FOUND,
          "Approved player with active WhatsApp identity not found",
        );
      }

      const identityRef = \`whatsapp:\${playerRow.external_id}\`;
      const existing = await client.query<{ id: string }>(
        \`SELECT id FROM admin_principals WHERE identity_ref = $1\`,
        [identityRef],
      );
      if (existing.rows[0] !== undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Player is already an administrator");
      }

      const requested = [...new Set(input.capabilities)].sort();
      if (requested.includes("UAT_BOOTSTRAP")) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "UAT capability cannot be delegated");
      }
      const known = await client.query<{ id: string; key: string }>(
        \`SELECT id, key
         FROM capabilities
         WHERE key = ANY($1::text[])
         ORDER BY key\`,
        [requested],
      );
      if (known.rows.length !== requested.length) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Unknown admin capability");
      }

      const principalId = randomUUID();
      await client.query(
        \`INSERT INTO admin_principals(id, identity_ref, status)
         VALUES ($1, $2, 'ACTIVE')\`,
        [principalId, identityRef],
      );
      await client.query(
        \`INSERT INTO admin_principal_scopes(
           id, principal_id, scope_type, scope_id, status
         ) VALUES ($1, $2, 'GLOBAL', NULL, 'ACTIVE')\`,
        [randomUUID(), principalId],
      );

      for (const capability of known.rows) {
        await client.query(
          \`INSERT INTO admin_principal_capability_overrides(
             principal_id, capability_id, decision, reason, assigned_by_admin_principal_id
           ) VALUES ($1, $2, 'GRANT', $3, $4)\`,
          [principalId, capability.id, input.reason, input.actorPrincipalId],
        );
      }

      if (input.receptionStaff) {
        if (!requested.includes("player.registration.read")) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_INPUT,
            "Reception staff requires player.registration.read",
          );
        }
        const reception = await client.query<{ id: string }>(
          \`SELECT id
           FROM community_groups
           WHERE role = 'RECEPTION' AND status = 'ACTIVE'
           ORDER BY created_at, id\`,
        );
        if (reception.rows.length !== 1 || reception.rows[0] === undefined) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_INPUT,
            "Exactly one active Reception is required",
          );
        }
        await client.query(
          \`INSERT INTO reception_staff_assignments(
             group_id, admin_principal_id, active, created_at, updated_at
           ) VALUES ($1, $2, TRUE, now(), now())\`,
          [reception.rows[0].id, principalId],
        );
      }

      await client.query(
        \`INSERT INTO audit_events(
           id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
           before_data, after_data, metadata, correlation_id, causation_id
         ) VALUES (
           $1, 'ADMIN', $2, 'admin.principal.create', 'ADMIN_PRINCIPAL', $3, 4, $4,
           '{}'::jsonb, $5::jsonb, $6::jsonb, $7, NULL
         )\`,
        [
          randomUUID(),
          input.actorPrincipalId,
          principalId,
          input.reason,
          JSON.stringify({
            playerId: input.playerId,
            displayName: playerRow.trainer_name,
            capabilities: requested,
            receptionStaff: input.receptionStaff,
          }),
          JSON.stringify({ source: "CENTRAL_ADMIN_TEAM" }),
          randomUUID(),
        ],
      );

      const refreshed = await client.query<PrincipalRow>(
        \`\${PRINCIPAL_SELECT} WHERE principal.id = $1\`,
        [principalId],
      );
      const row = refreshed.rows[0];
      if (row === undefined) throw new Error("Admin principal disappeared after creation");
      return principalView(row);
    });
  }

  public async setReceptionStaff(input: {
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly active: boolean;
    readonly reason: string;
  }): Promise<AdminTeamPrincipalView> {
    return withTransaction(this.pool, async (client) => {
      const actorOwner = await client.query<{ owner: boolean }>(
        \`SELECT EXISTS (
           SELECT 1
           FROM admin_principal_roles relation
           JOIN admin_roles role ON role.id = relation.role_id
           WHERE relation.principal_id = $1
             AND role.slug = 'OWNER_SECURITY_ADMIN'
         ) AS owner\`,
        [input.actorPrincipalId],
      );
      if (actorOwner.rows[0]?.owner !== true) {
        throw new AdminError(
          ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
          "Only protected owners can manage Reception staff",
        );
      }

      const target = await client.query<{ status: "ACTIVE" | "DISABLED" }>(
        \`SELECT status FROM admin_principals WHERE id = $1 FOR UPDATE\`,
        [input.targetPrincipalId],
      );
      if (target.rows[0] === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin principal not found");
      }
      if (target.rows[0].status !== "ACTIVE" && input.active) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Disabled admin cannot serve Reception");
      }

      if (input.active) {
        const capability = await client.query(
          \`SELECT 1
           FROM admin_effective_capabilities
           WHERE principal_id = $1 AND key = 'player.registration.read'\`,
          [input.targetPrincipalId],
        );
        if (capability.rowCount !== 1) {
          throw new AdminError(
            ADMIN_ERROR_CODES.INVALID_INPUT,
            "Reception staff requires player.registration.read",
          );
        }
      }

      const reception = await client.query<{ id: string }>(
        \`SELECT id
         FROM community_groups
         WHERE role = 'RECEPTION' AND status = 'ACTIVE'
         ORDER BY created_at, id\`,
      );
      if (reception.rows.length !== 1 || reception.rows[0] === undefined) {
        throw new AdminError(
          ADMIN_ERROR_CODES.INVALID_INPUT,
          "Exactly one active Reception is required",
        );
      }
      const groupId = reception.rows[0].id;

      const before = await client.query<{ active: boolean }>(
        \`SELECT active
         FROM reception_staff_assignments
         WHERE group_id = $1 AND admin_principal_id = $2\`,
        [groupId, input.targetPrincipalId],
      );
      const beforeActive = before.rows[0]?.active === true;

      await client.query(
        \`INSERT INTO reception_staff_assignments(
           group_id, admin_principal_id, active, created_at, updated_at
         ) VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (group_id, admin_principal_id) DO UPDATE
         SET active = EXCLUDED.active, updated_at = now()\`,
        [groupId, input.targetPrincipalId, input.active],
      );
      await client.query(
        \`UPDATE admin_principals SET revision = revision + 1 WHERE id = $1\`,
        [input.targetPrincipalId],
      );

      await client.query(
        \`INSERT INTO audit_events(
           id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
           before_data, after_data, metadata, correlation_id, causation_id
         ) VALUES (
           $1, 'ADMIN', $2, 'community.reception.staff.set', 'ADMIN_PRINCIPAL', $3, 3, $4,
           $5::jsonb, $6::jsonb, $7::jsonb, $8, NULL
         )\`,
        [
          randomUUID(),
          input.actorPrincipalId,
          input.targetPrincipalId,
          input.reason,
          JSON.stringify({ receptionStaff: beforeActive }),
          JSON.stringify({ receptionStaff: input.active }),
          JSON.stringify({ receptionGroupId: groupId }),
          randomUUID(),
        ],
      );

      const refreshed = await client.query<PrincipalRow>(
        \`\${PRINCIPAL_SELECT} WHERE principal.id = $1\`,
        [input.targetPrincipalId],
      );
      const row = refreshed.rows[0];
      if (row === undefined) throw new Error("Admin principal disappeared after Reception update");
      return principalView(row);
    });
  }

  public async replaceCapabilities(input: {
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly capabilities: readonly string[];
    readonly reason: string;
    readonly expectedRevision: bigint;
  }): Promise<AdminTeamPrincipalView> {
    return withTransaction(this.pool, async (client) => {
      const actorOwner = await client.query<{ owner: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM admin_principal_roles relation
           JOIN admin_roles role ON role.id = relation.role_id
           WHERE relation.principal_id = $1
             AND role.slug = 'OWNER_SECURITY_ADMIN'
         ) AS owner`,
        [input.actorPrincipalId],
      );
      if (actorOwner.rows[0]?.owner !== true) {
        throw new AdminError(
          ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
          "Only protected owners can manage administrative powers",
        );
      }

      const target = await client.query<{
        status: "ACTIVE" | "DISABLED";
        revision: string;
        owner: boolean;
      }>(
        `SELECT principal.status,
                principal.revision::text,
                EXISTS (
                  SELECT 1
                  FROM admin_principal_roles relation
                  JOIN admin_roles role ON role.id = relation.role_id
                  WHERE relation.principal_id = principal.id
                    AND role.slug = 'OWNER_SECURITY_ADMIN'
                ) AS owner
         FROM admin_principals principal
         WHERE principal.id = $1
         FOR UPDATE`,
        [input.targetPrincipalId],
      );
      const targetRow = target.rows[0];
      if (targetRow === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Admin principal not found");
      }
      if (targetRow.owner) {
        throw new AdminError(
          ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
          "Protected owner powers cannot be changed from the capability editor",
        );
      }
      if (BigInt(targetRow.revision) !== input.expectedRevision) {
        throw new AdminError(
          ADMIN_ERROR_CODES.REVISION_CONFLICT,
          "Admin principal revision changed",
        );
      }

      const requested = [...new Set(input.capabilities)].sort();
      const known = await client.query<{ id: string; key: string }>(
        `SELECT id, key
         FROM capabilities
         WHERE key = ANY($1::text[])
         ORDER BY key`,
        [requested],
      );
      if (known.rows.length !== requested.length) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Unknown admin capability");
      }
      if (requested.includes("UAT_BOOTSTRAP")) {
        throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "UAT capability cannot be delegated");
      }

      const before = await client.query<{ key: string }>(
        `SELECT key
         FROM admin_effective_capabilities
         WHERE principal_id = $1
         ORDER BY key`,
        [input.targetPrincipalId],
      );
      const beforeKeys = before.rows.map((row) => row.key);

      const roleGrants = await client.query<{ capability_id: string; key: string }>(
        `SELECT DISTINCT capability.id AS capability_id, capability.key
         FROM admin_principal_roles principal_role
         JOIN admin_role_capabilities relation ON relation.role_id = principal_role.role_id
         JOIN capabilities capability ON capability.id = relation.capability_id
         WHERE principal_role.principal_id = $1`,
        [input.targetPrincipalId],
      );
      const roleKeys = new Set(roleGrants.rows.map((row) => row.key));

      await client.query(
        `DELETE FROM admin_principal_capability_overrides
         WHERE principal_id = $1`,
        [input.targetPrincipalId],
      );

      const requestedSet = new Set(requested);
      const catalog = await client.query<{ id: string; key: string }>(
        `SELECT id, key FROM capabilities WHERE key <> 'UAT_BOOTSTRAP' ORDER BY key`,
      );
      for (const capability of catalog.rows) {
        const shouldHave = requestedSet.has(capability.key);
        const inherited = roleKeys.has(capability.key);
        const decision =
          shouldHave && !inherited ? "GRANT" : !shouldHave && inherited ? "DENY" : null;
        if (decision === null) continue;
        await client.query(
          `INSERT INTO admin_principal_capability_overrides(
             principal_id, capability_id, decision, reason, assigned_by_admin_principal_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.targetPrincipalId, capability.id, decision, input.reason, input.actorPrincipalId],
        );
      }

      const revision = await client.query<{ revision: string }>(
        `UPDATE admin_principals
         SET revision = revision + 1
         WHERE id = $1 AND revision = $2
         RETURNING revision::text`,
        [input.targetPrincipalId, input.expectedRevision.toString()],
      );
      if (revision.rows[0] === undefined) {
        throw new AdminError(ADMIN_ERROR_CODES.REVISION_CONFLICT, "Admin principal CAS failed");
      }

      const after = await client.query<{ key: string }>(
        `SELECT key
         FROM admin_effective_capabilities
         WHERE principal_id = $1
         ORDER BY key`,
        [input.targetPrincipalId],
      );
      const afterKeys = after.rows.map((row) => row.key);

      await client.query(
        `INSERT INTO audit_events(
           id, actor_type, actor_id, action, target_type, target_id, risk_tier, reason,
           before_data, after_data, metadata, correlation_id, causation_id
         ) VALUES (
           $1, 'ADMIN', $2, 'admin.capability.replace', 'ADMIN_PRINCIPAL', $3, 4, $4,
           $5::jsonb, $6::jsonb, $7::jsonb, $8, NULL
         )`,
        [
          randomUUID(),
          input.actorPrincipalId,
          input.targetPrincipalId,
          input.reason,
          JSON.stringify({ capabilities: beforeKeys, revision: targetRow.revision }),
          JSON.stringify({
            capabilities: afterKeys,
            revision: revision.rows[0].revision,
          }),
          JSON.stringify({ mode: "INDIVIDUAL_EFFECTIVE_CAPABILITIES" }),
          randomUUID(),
        ],
      );

      const refreshed = await client.query<PrincipalRow>(
        `${PRINCIPAL_SELECT} WHERE principal.id = $1`,
        [input.targetPrincipalId],
      );
      const row = refreshed.rows[0];
      if (row === undefined) throw new Error("Admin principal disappeared after capability update");
      return principalView(row);
    });
  }
}
