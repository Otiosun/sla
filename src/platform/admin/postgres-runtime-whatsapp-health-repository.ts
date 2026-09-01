import type { Pool } from "pg";
import type {
  RuntimeProviderState,
  RuntimeWhatsappHealthEvidence,
  RuntimeWhatsappHealthReadRepository,
} from "../../modules/admin/runtime-health-contracts.js";

interface RuntimeHealthRow {
  readonly provider_state: RuntimeProviderState;
  readonly deployment_revision: string;
  readonly started_at: Date;
  readonly last_connected_at: Date | null;
  readonly last_heartbeat_at: Date;
  readonly last_disconnect_at: Date | null;
  readonly stopped_at: Date | null;
}

export class PostgresRuntimeWhatsappHealthRepository
  implements RuntimeWhatsappHealthReadRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findLatest(
    environment: "staging" | "production",
  ): Promise<RuntimeWhatsappHealthEvidence | null> {
    const result = await this.pool.query<RuntimeHealthRow>(
      `SELECT provider_state,
              deployment_revision,
              started_at,
              last_connected_at,
              last_heartbeat_at,
              last_disconnect_at,
              stopped_at
       FROM runtime_instances
       WHERE environment = $1
       ORDER BY started_at DESC, instance_id DESC
       LIMIT 1`,
      [environment],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      providerState: row.provider_state,
      deploymentRevision: row.deployment_revision,
      startedAt: row.started_at,
      lastConnectedAt: row.last_connected_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastDisconnectAt: row.last_disconnect_at,
      stoppedAt: row.stopped_at,
    };
  }
}
