import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  MutationAdmissionDecision,
  MutationAdmissionPort,
  MutationAdmissionRequest,
} from "../../modules/anti-abuse/contracts.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

const HEX_64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_WINDOW_MS = 86_400_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validate(request: MutationAdmissionRequest): Result<MutationAdmissionRequest> {
  if (!TOKEN.test(request.policy.policyKey)) {
    return err(appError("VALIDATION_FAILED", "Mutation admission policyKey is invalid"));
  }
  if (!TOKEN.test(request.actionKey)) {
    return err(appError("VALIDATION_FAILED", "Mutation admission actionKey is invalid"));
  }
  if (request.subjectId.trim().length === 0 || request.subjectId.length > 512) {
    return err(appError("VALIDATION_FAILED", "Mutation admission subjectId is invalid"));
  }
  if (request.dedupeKey.trim().length === 0 || request.dedupeKey.length > 1024) {
    return err(appError("VALIDATION_FAILED", "Mutation admission dedupeKey is invalid"));
  }
  if (!HEX_64.test(request.requestFingerprint)) {
    return err(appError("VALIDATION_FAILED", "Mutation admission request fingerprint is invalid"));
  }
  if (!Number.isSafeInteger(request.policy.maxEvents) || request.policy.maxEvents <= 0) {
    return err(appError("VALIDATION_FAILED", "Mutation admission maxEvents is invalid"));
  }
  if (
    !Number.isSafeInteger(request.policy.windowMs) ||
    request.policy.windowMs <= 0 ||
    request.policy.windowMs > MAX_WINDOW_MS
  ) {
    return err(appError("VALIDATION_FAILED", "Mutation admission windowMs is invalid"));
  }
  return ok(request);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure; the pool will discard a broken connection if necessary.
  }
}

export class PostgresMutationAdmission implements MutationAdmissionPort {
  public constructor(private readonly pool: Pool) {}

  public async consume(
    rawRequest: MutationAdmissionRequest,
  ): Promise<Result<MutationAdmissionDecision>> {
    const parsed = validate(rawRequest);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const subjectHash = sha256(request.subjectId);
    const dedupeHash = sha256(request.dedupeKey);
    const lockKey = [
      request.subjectKind,
      subjectHash,
      request.surface,
      request.policy.policyKey,
    ].join(":");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);

      const prior = await client.query<{ request_fingerprint: string }>(
        `SELECT request_fingerprint
         FROM mutation_rate_limit_charges
         WHERE subject_kind = $1
           AND subject_hash = $2
           AND surface = $3
           AND policy_key = $4
           AND dedupe_hash = $5`,
        [
          request.subjectKind,
          subjectHash,
          request.surface,
          request.policy.policyKey,
          dedupeHash,
        ],
      );
      const priorFingerprint = prior.rows[0]?.request_fingerprint;
      if (priorFingerprint !== undefined) {
        await client.query("COMMIT");
        return priorFingerprint === request.requestFingerprint
          ? ok({ allowed: true, replayed: true, retryAfterMs: 0 })
          : err(
              appError("FINGERPRINT_MISMATCH", "Mutation idempotency key changed semantics", {
                surface: request.surface,
                actionKey: request.actionKey,
              }),
            );
      }

      const nowResult = await client.query<{ now_ms: string }>(
        "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms",
      );
      const nowMs = Number(nowResult.rows[0]?.now_ms);
      if (!Number.isSafeInteger(nowMs)) {
        throw new Error("PostgreSQL clock returned an invalid millisecond timestamp");
      }

      const bucket = await client.query<{ window_started_ms: string; used: number }>(
        `SELECT
           floor(extract(epoch FROM window_started_at) * 1000)::bigint::text AS window_started_ms,
           used
         FROM mutation_rate_limit_buckets
         WHERE subject_kind = $1
           AND subject_hash = $2
           AND surface = $3
           AND policy_key = $4`,
        [request.subjectKind, subjectHash, request.surface, request.policy.policyKey],
      );
      const stored = bucket.rows[0];
      const storedWindowMs = stored === undefined ? null : Number(stored.window_started_ms);
      const expired =
        stored === undefined ||
        !Number.isSafeInteger(storedWindowMs) ||
        nowMs - (storedWindowMs ?? nowMs) >= request.policy.windowMs;
      const windowStartedMs = expired ? nowMs : (storedWindowMs ?? nowMs);
      const used = expired ? 0 : (stored?.used ?? 0);

      if (used >= request.policy.maxEvents) {
        const retryAfterMs = Math.max(1, request.policy.windowMs - (nowMs - windowStartedMs));
        await client.query("COMMIT");
        return ok({ allowed: false, replayed: false, retryAfterMs });
      }

      await client.query(
        `INSERT INTO mutation_rate_limit_buckets(
           subject_kind, subject_hash, surface, policy_key, window_started_at, used, updated_at
         ) VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000), 1, clock_timestamp())
         ON CONFLICT (subject_kind, subject_hash, surface, policy_key)
         DO UPDATE SET
           window_started_at = EXCLUDED.window_started_at,
           used = $6,
           updated_at = clock_timestamp()`,
        [
          request.subjectKind,
          subjectHash,
          request.surface,
          request.policy.policyKey,
          windowStartedMs,
          used + 1,
        ],
      );
      await client.query(
        `INSERT INTO mutation_rate_limit_charges(
           id, subject_kind, subject_hash, surface, policy_key, action_key,
           dedupe_hash, request_fingerprint, window_started_at, charged_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           to_timestamp($9::double precision / 1000), clock_timestamp()
         )`,
        [
          randomUUID(),
          request.subjectKind,
          subjectHash,
          request.surface,
          request.policy.policyKey,
          request.actionKey,
          dedupeHash,
          request.requestFingerprint,
          windowStartedMs,
        ],
      );
      await client.query("COMMIT");
      return ok({ allowed: true, replayed: false, retryAfterMs: 0 });
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
