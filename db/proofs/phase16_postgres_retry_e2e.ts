import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { DeterministicRandomSource } from "../../src/platform/rng/index.js";
import {
  isRetryablePostgresTransactionError,
  withRetryingTransaction,
} from "../../src/platform/db/retrying-transaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 16 PostgreSQL retry proof");
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function firstAttemptBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await released;
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const deadlockTable = identifier("phase16_deadlock");
const serializationTable = identifier("phase16_serialization");

try {
  assert.equal(isRetryablePostgresTransactionError({ code: "40001" }), true);
  assert.equal(isRetryablePostgresTransactionError({ code: "40P01" }), true);
  assert.equal(isRetryablePostgresTransactionError({ code: "08006" }), false);
  assert.equal(isRetryablePostgresTransactionError({ code: "57014" }), false);
  assert.equal(isRetryablePostgresTransactionError(new Error("unknown")), false);

  await assert.rejects(
    withRetryingTransaction(pool, async (client) => client.query("SELECT 1"), {
      safety: { kind: "READ_ONLY" },
      transaction: { readOnly: false },
    }),
    /READ_ONLY retry safety requires a READ ONLY PostgreSQL transaction/,
  );

  await assert.rejects(
    withRetryingTransaction(pool, async (client) => client.query("SELECT 1"), {
      safety: { kind: "IDEMPOTENT_MUTATION", idempotencyKey: "   " },
      transaction: { isolationLevel: "READ COMMITTED" },
    }),
    /idempotency key/,
  );

  let unsafeFailureCalls = 0;
  await assert.rejects(
    withRetryingTransaction(
      pool,
      async () => {
        unsafeFailureCalls += 1;
        throw Object.assign(new Error("connection failure must not retry"), { code: "08006" });
      },
      {
        safety: { kind: "IDEMPOTENT_MUTATION", idempotencyKey: "phase16-unsafe-failure" },
        transaction: { isolationLevel: "READ COMMITTED" },
        maxAttempts: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
        rng: new DeterministicRandomSource(16),
        sleep: () => Promise.resolve(),
      },
    ),
    /connection failure must not retry/,
  );
  assert.equal(unsafeFailureCalls, 1);

  await pool.query(
    `CREATE TABLE "${deadlockTable}" (
       id integer PRIMARY KEY,
       value integer NOT NULL
     )`,
  );
  await pool.query(`INSERT INTO "${deadlockTable}"(id, value) VALUES (1, 0), (2, 0)`);

  const deadlockBarrier = firstAttemptBarrier();
  let deadlockCallsA = 0;
  let deadlockCallsB = 0;

  const runDeadlockMutation = async (
    key: string,
    firstId: number,
    secondId: number,
    countCall: () => number,
  ): Promise<void> => {
    await withRetryingTransaction(
      pool,
      async (client) => {
        const call = countCall();
        await client.query(`UPDATE "${deadlockTable}" SET value = value + 1 WHERE id = $1`, [
          firstId,
        ]);
        if (call === 1) await deadlockBarrier();
        await client.query(`UPDATE "${deadlockTable}" SET value = value + 1 WHERE id = $1`, [
          secondId,
        ]);
      },
      {
        safety: { kind: "IDEMPOTENT_MUTATION", idempotencyKey: key },
        transaction: { isolationLevel: "READ COMMITTED" },
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
        rng: new DeterministicRandomSource(1601),
        sleep: () => Promise.resolve(),
      },
    );
  };

  await Promise.all([
    runDeadlockMutation("phase16-deadlock-a", 1, 2, () => {
      deadlockCallsA += 1;
      return deadlockCallsA;
    }),
    runDeadlockMutation("phase16-deadlock-b", 2, 1, () => {
      deadlockCallsB += 1;
      return deadlockCallsB;
    }),
  ]);

  const deadlockRows = await pool.query<{ id: number; value: number }>(
    `SELECT id, value FROM "${deadlockTable}" ORDER BY id`,
  );
  assert.deepEqual(deadlockRows.rows, [
    { id: 1, value: 2 },
    { id: 2, value: 2 },
  ]);
  assert.equal(deadlockCallsA + deadlockCallsB, 3);

  await pool.query(
    `CREATE TABLE "${serializationTable}" (
       id integer PRIMARY KEY,
       on_call boolean NOT NULL
     )`,
  );
  await pool.query(`INSERT INTO "${serializationTable}"(id, on_call) VALUES (1, TRUE), (2, TRUE)`);

  const serializationBarrier = firstAttemptBarrier();
  let serializationCallsA = 0;
  let serializationCallsB = 0;

  const runSerializableMutation = async (
    key: string,
    ownId: number,
    countCall: () => number,
  ): Promise<void> => {
    await withRetryingTransaction(
      pool,
      async (client) => {
        const call = countCall();
        const current = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${serializationTable}" WHERE on_call`,
        );
        if (call === 1) await serializationBarrier();
        if (Number(current.rows[0]?.count ?? "0") > 1) {
          await client.query(`UPDATE "${serializationTable}" SET on_call = FALSE WHERE id = $1`, [
            ownId,
          ]);
        }
      },
      {
        safety: { kind: "IDEMPOTENT_MUTATION", idempotencyKey: key },
        transaction: { isolationLevel: "SERIALIZABLE" },
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
        rng: new DeterministicRandomSource(1602),
        sleep: () => Promise.resolve(),
      },
    );
  };

  await Promise.all([
    runSerializableMutation("phase16-serialization-a", 1, () => {
      serializationCallsA += 1;
      return serializationCallsA;
    }),
    runSerializableMutation("phase16-serialization-b", 2, () => {
      serializationCallsB += 1;
      return serializationCallsB;
    }),
  ]);

  const serializationState = await pool.query<{ on_call: string }>(
    `SELECT count(*)::text AS on_call FROM "${serializationTable}" WHERE on_call`,
  );
  assert.equal(serializationState.rows[0]?.on_call, "1");
  assert.equal(serializationCallsA + serializationCallsB, 3);

  console.log(
    "Phase 16 PostgreSQL retry proof complete: real deadlock/serialization retry safely, unknown failures do not retry",
  );
} finally {
  await pool.query(`DROP TABLE IF EXISTS "${deadlockTable}"`);
  await pool.query(`DROP TABLE IF EXISTS "${serializationTable}"`);
  await pool.end();
}
