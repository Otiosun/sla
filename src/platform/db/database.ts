import { Pool, type PoolClient, type PoolConfig } from "pg";

export interface DatabasePoolOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionSessionTimeoutMs: number;
}

export function createDatabasePool(options: DatabasePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeoutMs,
    allowExitOnIdle: false,
  };

  return new Pool(config);
}

export async function closeDatabasePool(pool: Pool): Promise<void> {
  await pool.end();
}

export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export type DatabaseClient = PoolClient;
