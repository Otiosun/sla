import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CommunityCapability,
  CommunityGroupRecord,
  CommunityGroupRole,
  RegisterCommunityGroupInput,
} from "../../modules/community/contracts.js";
import type {
  CommunityRepository,
  CommunityTransaction,
} from "../../modules/community/ports.js";
import { withTransaction } from "../db/transaction.js";

interface CommunityGroupRow {
  readonly id: string;
  readonly provider: string;
  readonly chat_ref: string;
  readonly role: CommunityGroupRole;
  readonly display_name: string;
  readonly status: "ACTIVE" | "RETIRED";
  readonly revision: string;
}

const GROUP_SELECT = `
  SELECT id, provider, chat_ref, role, display_name, status, revision::text
  FROM community_groups`;

function group(row: CommunityGroupRow): CommunityGroupRecord {
  return {
    id: row.id,
    provider: row.provider,
    chatRef: row.chat_ref,
    role: row.role,
    displayName: row.display_name,
    status: row.status,
    revision: Number(row.revision),
  };
}

class PostgresCommunityTransaction implements CommunityTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async loadGroupByProviderRef(
    provider: string,
    chatRef: string,
  ): Promise<CommunityGroupRecord | null> {
    const result = await this.client.query<CommunityGroupRow>(
      `${GROUP_SELECT} WHERE provider = $1 AND chat_ref = $2`,
      [provider, chatRef],
    );
    const row = result.rows[0];
    return row === undefined ? null : group(row);
  }

  public async loadGroupById(groupId: string): Promise<CommunityGroupRecord | null> {
    const result = await this.client.query<CommunityGroupRow>(`${GROUP_SELECT} WHERE id = $1`, [
      groupId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : group(row);
  }

  public async listGroupsByRole(role: CommunityGroupRole): Promise<readonly CommunityGroupRecord[]> {
    const result = await this.client.query<CommunityGroupRow>(
      `${GROUP_SELECT} WHERE role = $1 ORDER BY created_at, id`,
      [role],
    );
    return result.rows.map(group);
  }

  public async listCapabilities(groupId: string): Promise<readonly CommunityCapability[]> {
    const result = await this.client.query<{ capability_key: CommunityCapability }>(
      `SELECT capability_key
       FROM community_group_capabilities
       WHERE group_id = $1 AND active = TRUE
       ORDER BY capability_key`,
      [groupId],
    );
    return result.rows.map((row) => row.capability_key);
  }

  public async insertGroup(
    input: RegisterCommunityGroupInput,
  ): Promise<CommunityGroupRecord | null> {
    const result = await this.client.query<CommunityGroupRow>(
      `INSERT INTO community_groups(id, provider, chat_ref, role, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, chat_ref) DO NOTHING
       RETURNING id, provider, chat_ref, role, display_name, status, revision::text`,
      [randomUUID(), input.provider, input.chatRef, input.role, input.displayName],
    );
    const row = result.rows[0];
    return row === undefined ? null : group(row);
  }

  public async renameGroup(
    groupId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<CommunityGroupRecord | null> {
    const result = await this.client.query<CommunityGroupRow>(
      `UPDATE community_groups
       SET display_name = $2, revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $3 AND status = 'ACTIVE'
       RETURNING id, provider, chat_ref, role, display_name, status, revision::text`,
      [groupId, displayName, expectedRevision],
    );
    const row = result.rows[0];
    return row === undefined ? null : group(row);
  }

  public async replaceCapabilities(
    groupId: string,
    capabilities: readonly CommunityCapability[],
    expectedRevision: number,
  ): Promise<CommunityGroupRecord | null> {
    const updated = await this.client.query<CommunityGroupRow>(
      `UPDATE community_groups
       SET revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $2 AND status = 'ACTIVE'
       RETURNING id, provider, chat_ref, role, display_name, status, revision::text`,
      [groupId, expectedRevision],
    );
    const row = updated.rows[0];
    if (row === undefined) return null;

    await this.client.query(
      `UPDATE community_group_capabilities
       SET active = FALSE, updated_at = now()
       WHERE group_id = $1 AND active = TRUE`,
      [groupId],
    );
    for (const capability of capabilities) {
      await this.client.query(
        `INSERT INTO community_group_capabilities(group_id, capability_key, active)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (group_id, capability_key) DO UPDATE
         SET active = TRUE, updated_at = now()`,
        [groupId, capability],
      );
    }
    return group(row);
  }

  public async retireGroup(
    groupId: string,
    expectedRevision: number,
  ): Promise<CommunityGroupRecord | null> {
    const result = await this.client.query<CommunityGroupRow>(
      `UPDATE community_groups
       SET status = 'RETIRED', retired_at = now(), revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $2 AND status = 'ACTIVE'
       RETURNING id, provider, chat_ref, role, display_name, status, revision::text`,
      [groupId, expectedRevision],
    );
    const row = result.rows[0];
    return row === undefined ? null : group(row);
  }

  public async assignReceptionStaff(groupId: string, adminPrincipalId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO reception_staff_assignments(group_id, admin_principal_id, active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (group_id, admin_principal_id) DO UPDATE
       SET active = TRUE, updated_at = now()`,
      [groupId, adminPrincipalId],
    );
  }

  public async listReceptionStaff(groupId: string): Promise<readonly string[]> {
    const result = await this.client.query<{ admin_principal_id: string }>(
      `SELECT admin_principal_id
       FROM reception_staff_assignments
       WHERE group_id = $1 AND active = TRUE
       ORDER BY admin_principal_id`,
      [groupId],
    );
    return result.rows.map((row) => row.admin_principal_id);
  }
}

export class PostgresCommunityRepository implements CommunityRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresCommunityTransaction(client)),
      { isolationLevel: "READ COMMITTED" },
    );
  }

  public async read<T>(work: (tx: CommunityTransaction) => Promise<T>): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => work(new PostgresCommunityTransaction(client)),
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
