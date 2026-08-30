import type { Pool } from "pg";
import type {
  AdminApiRateLimitDecision,
  AdminApiRateLimitedOperation,
  AdminApiRateLimiter,
  AdminApiRateLimitRequest,
} from "../../adapters/admin-api/fastify-server.js";

export interface AdminApiRateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export type AdminApiRateLimitPolicyOverrides = Partial<
  Record<AdminApiRateLimitedOperation, AdminApiRateLimitPolicy>
>;

const DEFAULT_POLICIES: Readonly<Record<AdminApiRateLimitedOperation, AdminApiRateLimitPolicy>> = {
  "session.read": { limit: 120, windowSeconds: 60 },
  "player.search": { limit: 60, windowSeconds: 60 },
  "player.read": { limit: 120, windowSeconds: 60 },
};

interface RateLimitRow {
  readonly request_count: number | string;
  readonly retry_after_seconds: number | string;
}

function validatePolicy(operation: AdminApiRateLimitedOperation, policy: AdminApiRateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.limit) || policy.limit <= 0) {
    throw new Error(`Invalid Admin API rate-limit policy for ${operation}: limit must be positive`);
  }
  if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds <= 0) {
    throw new Error(
      `Invalid Admin API rate-limit policy for ${operation}: windowSeconds must be positive`,
    );
  }
}

export class PostgresAdminApiRateLimiter implements AdminApiRateLimiter {
  private readonly policies: Readonly<Record<AdminApiRateLimitedOperation, AdminApiRateLimitPolicy>>;

  public constructor(pool: Pool, overrides: AdminApiRateLimitPolicyOverrides = {}) {
    this.pool = pool;
    this.policies = {
      "session.read": overrides["session.read"] ?? DEFAULT_POLICIES["session.read"],
      "player.search": overrides["player.search"] ?? DEFAULT_POLICIES["player.search"],
      "player.read": overrides["player.read"] ?? DEFAULT_POLICIES["player.read"],
    };

    validatePolicy("session.read", this.policies["session.read"]);
    validatePolicy("player.search", this.policies["player.search"]);
    validatePolicy("player.read", this.policies["player.read"]);
  }

  private readonly pool: Pool;

  public async consume(request: AdminApiRateLimitRequest): Promise<AdminApiRateLimitDecision> {
    const policy = this.policies[request.operation];
    const result = await this.pool.query<RateLimitRow>(
      `WITH observed AS MATERIALIZED (
         SELECT clock_timestamp() AS observed_at
       ), upserted AS (
         INSERT INTO admin_api_rate_limit_buckets (
           principal_id,
           operation,
           window_started_at,
           request_count,
           updated_at
         )
         SELECT $1::uuid, $2::text, observed_at, 1, observed_at
         FROM observed
         ON CONFLICT (principal_id, operation)
         DO UPDATE SET
           window_started_at = CASE
             WHEN admin_api_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $3::double precision)
             THEN (SELECT observed_at FROM observed)
             ELSE admin_api_rate_limit_buckets.window_started_at
           END,
           request_count = CASE
             WHEN admin_api_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $3::double precision)
             THEN 1
             ELSE admin_api_rate_limit_buckets.request_count + 1
           END,
           updated_at = (SELECT observed_at FROM observed)
         RETURNING request_count, window_started_at
       )
       SELECT
         upserted.request_count,
         GREATEST(
           1,
           CEIL(
             EXTRACT(
               EPOCH FROM (
                 upserted.window_started_at
                 + make_interval(secs => $3::double precision)
                 - observed.observed_at
               )
             )
           )
         )::integer AS retry_after_seconds
       FROM upserted
       CROSS JOIN observed`,
      [request.principalId, request.operation, policy.windowSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Admin API rate limiter did not return a decision");
    }

    const requestCount = Number(row.request_count);
    const retryAfterSeconds = Number(row.retry_after_seconds);
    if (!Number.isSafeInteger(requestCount) || requestCount <= 0) {
      throw new Error("Admin API rate limiter returned an invalid request count");
    }
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new Error("Admin API rate limiter returned an invalid retry interval");
    }

    return {
      allowed: requestCount <= policy.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    };
  }
}
