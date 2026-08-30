import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresRuntimeHealthRepository } from "../../src/runtime/postgres-runtime-health.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const revision = process.env.PROOF_REVISION;
if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error("PROOF_REVISION must be a full lowercase Git SHA");
}

const pool = new Pool({ connectionString, max: 3 });
const repository = new PostgresRuntimeHealthRepository(pool);
const sessionKey = "runtime-health-proof";
const firstInstanceId = randomUUID();
const secondInstanceId = randomUUID();

async function row(instanceId: string) {
  const result = await pool.query<{
    provider_state: string;
    deployment_revision: string;
    environment: string;
    whatsapp_session_key: string;
    last_connected_at: Date | null;
    last_heartbeat_at: Date;
    last_disconnect_at: Date | null;
    stopped_at: Date | null;
    shutdown_reason: string | null;
  }>(
    `SELECT provider_state, deployment_revision, environment, whatsapp_session_key,
            last_connected_at, last_heartbeat_at, last_disconnect_at, stopped_at, shutdown_reason
       FROM runtime_instances
      WHERE instance_id = $1`,
    [instanceId],
  );
  const value = result.rows[0];
  if (!value) throw new Error(`missing runtime instance ${instanceId}`);
  return value;
}

try {
  const privileges = await pool.query<{
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(`SELECT
        has_table_privilege(current_user, 'runtime_instances', 'SELECT') AS can_select,
        has_table_privilege(current_user, 'runtime_instances', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'runtime_instances', 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'runtime_instances', 'DELETE') AS can_delete`);
  const privilege = privileges.rows[0];
  if (!privilege?.can_select || !privilege.can_insert || !privilege.can_update || privilege.can_delete) {
    throw new Error(`unexpected runtime health privileges: ${JSON.stringify(privilege)}`);
  }

  await repository.register({
    instanceId: firstInstanceId,
    environment: "staging",
    deploymentRevision: revision,
    whatsappSessionKey: sessionKey,
  });
  let current = await row(firstInstanceId);
  if (current.provider_state !== "STARTING") throw new Error("new runtime must start STARTING");
  if (current.deployment_revision !== revision) throw new Error("deployment revision drifted");
  if (current.environment !== "staging") throw new Error("environment drifted");
  if (current.whatsapp_session_key !== sessionKey) throw new Error("session key drifted");

  const heartbeatBefore = current.last_heartbeat_at.getTime();
  await repository.markConnected(firstInstanceId);
  current = await row(firstInstanceId);
  if (current.provider_state !== "CONNECTED" || current.last_connected_at === null) {
    throw new Error("connected transition was not persisted");
  }

  await new Promise((resolve) => setTimeout(resolve, 5));
  await repository.heartbeat(firstInstanceId);
  current = await row(firstInstanceId);
  if (current.last_heartbeat_at.getTime() <= heartbeatBefore) {
    throw new Error("heartbeat did not advance");
  }

  await repository.markDisconnected(firstInstanceId);
  current = await row(firstInstanceId);
  if (current.provider_state !== "DISCONNECTED" || current.last_disconnect_at === null) {
    throw new Error("disconnect transition was not persisted");
  }

  await repository.stop(firstInstanceId, "STOPPED", "SIGTERM");
  current = await row(firstInstanceId);
  if (current.provider_state !== "STOPPED" || current.stopped_at === null) {
    throw new Error("terminal stop was not persisted");
  }
  if (current.shutdown_reason !== "SIGTERM") throw new Error("shutdown reason was not preserved");

  await repository.register({
    instanceId: secondInstanceId,
    environment: "staging",
    deploymentRevision: revision,
    whatsappSessionKey: sessionKey,
  });
  const history = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM runtime_instances
      WHERE environment = 'staging' AND whatsapp_session_key = $1 AND deployment_revision = $2`,
    [sessionKey, revision],
  );
  if (history.rows[0]?.count !== "2") throw new Error("runtime instance history was not preserved");

  for (const invalid of [
    ["qa", revision, sessionKey],
    ["staging", "not-a-sha", sessionKey],
    ["staging", revision, "Invalid Session Key"],
  ] as const) {
    let rejected = false;
    try {
      await pool.query(
        `INSERT INTO runtime_instances(instance_id, environment, deployment_revision, whatsapp_session_key, provider_state)
         VALUES ($1, $2, $3, $4, 'STARTING')`,
        [randomUUID(), invalid[0], invalid[1], invalid[2]],
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`invalid runtime evidence was accepted: ${JSON.stringify(invalid)}`);
  }

  let deleteRejected = false;
  try {
    await pool.query(`DELETE FROM runtime_instances WHERE instance_id = $1`, [secondInstanceId]);
  } catch {
    deleteRejected = true;
  }
  if (!deleteRejected) throw new Error("runtime role unexpectedly deleted operational evidence");

  console.log("Phase 17 runtime health evidence proof passed");
} finally {
  await pool.end();
}
