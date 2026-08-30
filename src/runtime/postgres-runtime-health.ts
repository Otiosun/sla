import type { Pool } from "pg";

export type RuntimeEnvironment = "staging" | "production";
export type RuntimeTerminalState = "STOPPED" | "INVALIDATED";

export interface RuntimeInstanceRegistration {
  readonly instanceId: string;
  readonly environment: RuntimeEnvironment;
  readonly deploymentRevision: string;
  readonly whatsappSessionKey: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const SESSION_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertInstanceId(value: string): void {
  if (!UUID.test(value)) throw new Error("runtime instanceId must be a UUID");
}

function assertRegistration(input: RuntimeInstanceRegistration): void {
  assertInstanceId(input.instanceId);
  if (input.environment !== "staging" && input.environment !== "production") {
    throw new Error("runtime environment must be staging or production");
  }
  if (!FULL_SHA.test(input.deploymentRevision)) {
    throw new Error("runtime deploymentRevision must be a full lowercase Git SHA");
  }
  if (!SESSION_KEY.test(input.whatsappSessionKey)) {
    throw new Error("runtime WhatsApp session key is invalid");
  }
}

function assertShutdownReason(reason: string): void {
  if (reason.length < 1 || reason.length > 128) {
    throw new Error("runtime shutdown reason must contain 1 to 128 characters");
  }
}

export class PostgresRuntimeHealthRepository {
  public constructor(private readonly pool: Pool) {}

  public async register(input: RuntimeInstanceRegistration): Promise<void> {
    assertRegistration(input);
    await this.pool.query(
      `INSERT INTO runtime_instances(
         instance_id,
         environment,
         deployment_revision,
         whatsapp_session_key,
         provider_state
       ) VALUES ($1, $2, $3, $4, 'STARTING')`,
      [input.instanceId, input.environment, input.deploymentRevision, input.whatsappSessionKey],
    );
  }

  public async markConnected(instanceId: string): Promise<void> {
    assertInstanceId(instanceId);
    const result = await this.pool.query(
      `UPDATE runtime_instances
          SET provider_state = 'CONNECTED',
              last_connected_at = clock_timestamp(),
              last_heartbeat_at = clock_timestamp()
        WHERE instance_id = $1
          AND stopped_at IS NULL`,
      [instanceId],
    );
    this.assertUpdated(result.rowCount, "connect");
  }

  public async markDisconnected(instanceId: string): Promise<void> {
    assertInstanceId(instanceId);
    const result = await this.pool.query(
      `UPDATE runtime_instances
          SET provider_state = 'DISCONNECTED',
              last_disconnect_at = clock_timestamp(),
              last_heartbeat_at = clock_timestamp()
        WHERE instance_id = $1
          AND stopped_at IS NULL`,
      [instanceId],
    );
    this.assertUpdated(result.rowCount, "disconnect");
  }

  public async heartbeat(instanceId: string): Promise<void> {
    assertInstanceId(instanceId);
    const result = await this.pool.query(
      `UPDATE runtime_instances
          SET last_heartbeat_at = clock_timestamp()
        WHERE instance_id = $1
          AND stopped_at IS NULL`,
      [instanceId],
    );
    this.assertUpdated(result.rowCount, "heartbeat");
  }

  public async stop(
    instanceId: string,
    terminalState: RuntimeTerminalState,
    shutdownReason: string,
  ): Promise<void> {
    assertInstanceId(instanceId);
    assertShutdownReason(shutdownReason);
    if (terminalState !== "STOPPED" && terminalState !== "INVALIDATED") {
      throw new Error("runtime terminal state is invalid");
    }

    const result = await this.pool.query(
      `UPDATE runtime_instances
          SET provider_state = $2,
              last_heartbeat_at = clock_timestamp(),
              stopped_at = clock_timestamp(),
              shutdown_reason = $3
        WHERE instance_id = $1
          AND stopped_at IS NULL`,
      [instanceId, terminalState, shutdownReason],
    );
    if (result.rowCount === 1) return;

    const replay = await this.pool.query<{ provider_state: string; shutdown_reason: string | null }>(
      `SELECT provider_state, shutdown_reason
         FROM runtime_instances
        WHERE instance_id = $1`,
      [instanceId],
    );
    const current = replay.rows[0];
    if (current?.provider_state === terminalState && current.shutdown_reason === shutdownReason) return;
    throw new Error("runtime instance could not transition to terminal state");
  }

  private assertUpdated(rowCount: number | null, operation: string): void {
    if (rowCount !== 1) {
      throw new Error(`runtime instance ${operation} update did not affect exactly one active row`);
    }
  }
}
