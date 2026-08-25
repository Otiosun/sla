import type { Pool, PoolClient } from "pg";

export type TransactionIsolationLevel =
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}

function buildBeginStatement(options: TransactionOptions): string {
  const parts = ["BEGIN"];

  if (options.isolationLevel !== undefined) {
    parts.push(`ISOLATION LEVEL ${options.isolationLevel}`);
  }
  if (options.readOnly === true) {
    parts.push("READ ONLY");
  }
  if (options.deferrable === true) {
    if (options.isolationLevel !== "SERIALIZABLE" || options.readOnly !== true) {
      throw new Error("DEFERRABLE requires a SERIALIZABLE READ ONLY transaction");
    }
    parts.push("DEFERRABLE");
  }
  return parts.join(" ");
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(buildBeginStatement(options));
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
