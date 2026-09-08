import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import type {
  PublicVerificationRateLimitDecision,
  PublicVerificationRateLimiter,
} from "../../adapters/public-api/fastify-server.js";

export interface PublicVerificationRateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

interface RateLimitRow {
  readonly request_count: number | string;
  readonly retry_after_seconds: number | string;
}

function keyedHash(pepper: Uint8Array, scope: string, value: string): string {
  return createHmac("sha256", pepper).update(scope).update("\0").update(value).digest("hex");
}

export class PostgresPublicVerificationRateLimiter implements PublicVerificationRateLimiter {
  private readonly pepper: Uint8Array;

  public constructor(
    private readonly pool: Pool,
    pepper: Uint8Array,
    private readonly policy: PublicVerificationRateLimitPolicy,
  ) {
    if (pepper.byteLength < 32) {
      throw new Error("Public verification rate-limit pepper must be at least 32 bytes");
    }
    if (!Number.isSafeInteger(policy.limit) || policy.limit <= 0) {
      throw new Error("Public verification rate-limit limit must be positive");
    }
    if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds <= 0) {
      throw new Error("Public verification rate-limit window must be positive");
    }
    this.pepper = new Uint8Array(pepper);
  }

  public async consume(request: {
    readonly publicId: string;
    readonly remoteAddress: string;
  }): Promise<PublicVerificationRateLimitDecision> {
    const peerHash = keyedHash(this.pepper, "peer", request.remoteAddress);
    const targetHash = keyedHash(this.pepper, "target", request.publicId);
    const result = await this.pool.query<RateLimitRow>(
      `WITH observed AS MATERIALIZED (
         SELECT clock_timestamp() AS observed_at
       ), upserted AS (
         INSERT INTO public_verification_rate_limit_buckets (
           peer_hash,
           target_hash,
           window_started_at,
           request_count,
           updated_at
         )
         SELECT $1, $2, observed_at, 1, observed_at
         FROM observed
         ON CONFLICT (peer_hash, target_hash)
         DO UPDATE SET
           window_started_at = CASE
             WHEN public_verification_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $3::double precision)
             THEN (SELECT observed_at FROM observed)
             ELSE public_verification_rate_limit_buckets.window_started_at
           END,
           request_count = CASE
             WHEN public_verification_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $3::double precision)
             THEN 1
             ELSE public_verification_rate_limit_buckets.request_count + 1
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
      [peerHash, targetHash, this.policy.windowSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Public verification rate limiter did not return a decision");
    }

    const requestCount = Number(row.request_count);
    const retryAfterSeconds = Number(row.retry_after_seconds);
    if (!Number.isSafeInteger(requestCount) || requestCount <= 0) {
      throw new Error("Public verification rate limiter returned an invalid request count");
    }
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new Error("Public verification rate limiter returned an invalid retry interval");
    }

    return {
      allowed: requestCount <= this.policy.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    };
  }
}
