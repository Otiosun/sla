import type { Pool, PoolClient } from "pg";
import { type MetricSink, monotonicNowMs, NOOP_METRICS } from "../metrics/index.js";
import { CryptoRandomSource, type RandomSource } from "../rng/index.js";
import { type RetrySafety, withSafeRetry } from "../../shared-kernel/retry.js";
import { type TransactionOptions, withTransaction } from "./transaction.js";

const RETRYABLE_TRANSACTION_SQLSTATES = new Set(["40001", "40P01"]);

export interface RetryingTransactionOptions {
  readonly safety: RetrySafety;
  readonly transaction?: TransactionOptions;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly rng?: RandomSource;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly metrics?: MetricSink;
}

function postgresSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isRetryablePostgresTransactionError(error: unknown): boolean {
  const code = postgresSqlState(error);
  return code !== null && RETRYABLE_TRANSACTION_SQLSTATES.has(code);
}

function assertRetryBoundary(options: RetryingTransactionOptions): void {
  const readOnly = options.transaction?.readOnly === true;
  if (options.safety.kind === "READ_ONLY" && !readOnly) {
    throw new Error("READ_ONLY retry safety requires a READ ONLY PostgreSQL transaction");
  }
  if (options.safety.kind === "IDEMPOTENT_MUTATION" && readOnly) {
    throw new Error("IDEMPOTENT_MUTATION retry safety cannot use a READ ONLY transaction");
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function withRetryingTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: RetryingTransactionOptions,
): Promise<T> {
  assertRetryBoundary(options);

  const metrics = options.metrics ?? NOOP_METRICS;
  const startedAtMs = monotonicNowMs();
  let attempts = 0;
  let failed = false;

  try {
    return await withSafeRetry(
      () => {
        attempts += 1;
        return withTransaction(pool, work, options.transaction);
      },
      {
        safety: options.safety,
        maxAttempts: options.maxAttempts ?? 3,
        baseDelayMs: options.baseDelayMs ?? 10,
        maxDelayMs: options.maxDelayMs ?? 250,
        jitterRatio: options.jitterRatio ?? 0.2,
        isRetryable: isRetryablePostgresTransactionError,
      },
      {
        rng: options.rng ?? new CryptoRandomSource(),
        sleep: options.sleep ?? defaultSleep,
      },
    );
  } catch (error) {
    failed = true;
    metrics.increment("db.transaction.errors_total", 1, {
      safety: options.safety.kind,
      sqlstate: postgresSqlState(error) ?? "unknown",
    });
    throw error;
  } finally {
    metrics.observe("db.transaction.duration_ms", monotonicNowMs() - startedAtMs, {
      result: failed ? "error" : "success",
      safety: options.safety.kind,
    });
    metrics.observe("db.transaction.attempts", attempts, {
      result: failed ? "error" : "success",
      safety: options.safety.kind,
    });
    if (attempts > 1) {
      metrics.increment("db.transaction.retries_total", attempts - 1, {
        safety: options.safety.kind,
      });
    }
  }
}
