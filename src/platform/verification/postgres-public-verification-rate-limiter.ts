import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import type {
  PublicVerificationRateLimitDecision,
  PublicVerificationRateLimiter,
} from "../../adapters/public-api/fastify-server.js";

export interface PublicVerificationRateLimitPolicy {
  readonly limit: number;
  readonly peerLimit: number;
  readonly windowSeconds: number;
}

interface RateLimitRow {
  readonly peer_request_count: number | string;
  readonly target_request_count: number | string;
  readonly peer_retry_after_seconds: number | string;
  readonly target_retry_after_seconds: number | string;
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
    if (!Number.isSafeInteger(policy.peerLimit) || policy.peerLimit <= 0) {
      throw new Error("Public verification peer-wide rate-limit must be positive");
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
    const peerWideTargetHash = keyedHash(this.pepper, "peer-wide-target", "v1");
    const result = await this.pool.query<RateLimitRow>(
      `WITH observed AS MATERIALIZED (
         SELECT clock_timestamp() AS observed_at
       ), peer_upserted AS (
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
               (SELECT observed_at FROM observed) - make_interval(secs => $4::double precision)
             THEN (SELECT observed_at FROM observed)
             ELSE public_verification_rate_limit_buckets.window_started_at
           END,
           request_count = CASE
             WHEN public_verification_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $4::double precision)
             THEN 1
             ELSE public_verification_rate_limit_buckets.request_count + 1
           END,
           updated_at = (SELECT observed_at FROM observed)
         RETURNING request_count, window_started_at
       ), target_upserted AS (
         INSERT INTO public_verification_rate_limit_buckets (
           peer_hash,
           target_hash,
           window_started_at,
           request_count,
           updated_at
         )
         SELECT $1, $3, observed.observed_at, 1, observed.observed_at
         FROM observed
         CROSS JOIN peer_upserted
         ON CONFLICT (peer_hash, target_hash)
         DO UPDATE SET
           window_started_at = CASE
             WHEN public_verification_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $4::double precision)
             THEN (SELECT observed_at FROM observed)
             ELSE public_verification_rate_limit_buckets.window_started_at
           END,
           request_count = CASE
             WHEN public_verification_rate_limit_buckets.window_started_at <=
               (SELECT observed_at FROM observed) - make_interval(secs => $4::double precision)
             THEN 1
             ELSE public_verification_rate_limit_buckets.request_count + 1
           END,
           updated_at = (SELECT observed_at FROM observed)
         RETURNING request_count, window_started_at
       )
       SELECT
         peer_upserted.request_count AS peer_request_count,
         target_upserted.request_count AS target_request_count,
         GREATEST(
           1,
           CEIL(
             EXTRACT(
               EPOCH FROM (
                 peer_upserted.window_started_at
                 + make_interval(secs => $4::double precision)
                 - observed.observed_at
               )
             )
           )
         )::integer AS peer_retry_after_seconds,
         GREATEST(
           1,
           CEIL(
             EXTRACT(
               EPOCH FROM (
                 target_upserted.window_started_at
                 + make_interval(secs => $4::double precision)
                 - observed.observed_at
               )
             )
           )
         )::integer AS target_retry_after_seconds
       FROM peer_upserted
       CROSS JOIN target_upserted
       CROSS JOIN observed`,
      [peerHash, peerWideTargetHash, targetHash, this.policy.windowSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Public verification rate limiter did not return a decision");
    }

    const peerRequestCount = Number(row.peer_request_count);
    const targetRequestCount = Number(row.target_request_count);
    const peerRetryAfterSeconds = Number(row.peer_retry_after_seconds);
    const targetRetryAfterSeconds = Number(row.target_retry_after_seconds);
    if (!Number.isSafeInteger(peerRequestCount) || peerRequestCount <= 0) {
      throw new Error("Public verification rate limiter returned an invalid peer request count");
    }
    if (!Number.isSafeInteger(targetRequestCount) || targetRequestCount <= 0) {
      throw new Error("Public verification rate limiter returned an invalid target request count");
    }
    if (!Number.isFinite(peerRetryAfterSeconds) || peerRetryAfterSeconds < 1) {
      throw new Error("Public verification rate limiter returned an invalid peer retry interval");
    }
    if (!Number.isFinite(targetRetryAfterSeconds) || targetRetryAfterSeconds < 1) {
      throw new Error("Public verification rate limiter returned an invalid target retry interval");
    }

    const peerAllowed = peerRequestCount <= this.policy.peerLimit;
    const targetAllowed = targetRequestCount <= this.policy.limit;
    const retryAfterSeconds = Math.max(
      peerAllowed ? 1 : peerRetryAfterSeconds,
      targetAllowed ? 1 : targetRetryAfterSeconds,
    );

    return {
      allowed: peerAllowed && targetAllowed,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    };
  }
}
