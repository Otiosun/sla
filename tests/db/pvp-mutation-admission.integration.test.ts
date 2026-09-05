import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExternalPvpMutationEndpoint,
  type PvpMutationOwner,
} from "../../src/modules/anti-abuse/external-pvp-endpoint.js";
import type { MutationRatePolicy } from "../../src/modules/anti-abuse/contracts.js";
import { PostgresMutationAdmission } from "../../src/platform/anti-abuse/postgres-mutation-admission.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { appError, err } from "../../src/shared-kernel/result.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined) {
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  }
  return value;
})();

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const proofPolicy: MutationRatePolicy = {
  policyKey: "battle.pvp-replay-proof.v1",
  maxEvents: 3,
  windowMs: 60_000,
};

function proofOwner(): PvpMutationOwner {
  return {
    async createChallenge() {
      return err(appError("ACTION_INVALID", "proof owner"));
    },
    async acceptChallenge() {
      return err(appError("ACTION_INVALID", "proof owner"));
    },
    async startEncounter() {
      return err(appError("ACTION_INVALID", "proof owner"));
    },
  };
}

describe("PVP PostgreSQL mutation admission", () => {
  const dbName = `pokemon_pvp_admission_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 6 });
    await runMigrations(pool, { appliedBy: "flow003-pvp-admission-vitest" });
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminPool.end();
  }, 30_000);

  it("charges each PVP mutation once and treats exact retries as admission replays", async () => {
    const endpoint = new ExternalPvpMutationEndpoint(
      proofOwner(),
      new PostgresMutationAdmission(pool),
      proofPolicy,
    );
    const challengerPlayerId = randomUUID();
    const targetPlayerId = randomUUID();
    const challengeId = randomUUID();
    const create = {
      challengerPlayerId,
      targetPlayerId,
      formatKey: "1V1" as const,
      reachPolicy: "SAME_AREA" as const,
      idempotencyKey: "pvp-replay-create",
    };
    const accept = { challengeId, actorPlayerId: targetPlayerId };
    const start = { challengeId, actorPlayerId: challengerPlayerId };

    await endpoint.createChallenge(create);
    await endpoint.createChallenge(create);
    await endpoint.acceptChallenge(accept);
    await endpoint.acceptChallenge(accept);
    await endpoint.startEncounter(start);
    await endpoint.startEncounter(start);

    const charges = await pool.query<{
      subject_hash: string;
      surface: string;
      action_key: string;
      dedupe_hash: string;
      request_fingerprint: string;
    }>(
      `SELECT subject_hash, surface, action_key, dedupe_hash, request_fingerprint
       FROM mutation_rate_limit_charges
       WHERE policy_key = $1
       ORDER BY action_key`,
      [proofPolicy.policyKey],
    );
    expect(charges.rows).toHaveLength(3);
    expect(charges.rows.map((row) => row.action_key)).toEqual([
      "pvp.accept-challenge",
      "pvp.create-challenge",
      "pvp.start-encounter",
    ]);
    expect(new Set(charges.rows.map((row) => row.surface))).toEqual(new Set(["BATTLE"]));
    for (const row of charges.rows) {
      expect(row.subject_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.dedupe_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_hash).not.toBe(challengerPlayerId);
      expect(row.subject_hash).not.toBe(targetPlayerId);
    }

    const bucket = await pool.query<{ used: number }>(
      `SELECT used
       FROM mutation_rate_limit_buckets
       WHERE surface = 'BATTLE' AND policy_key = $1`,
      [proofPolicy.policyKey],
    );
    expect(bucket.rows.reduce((total, row) => total + row.used, 0)).toBe(3);
  }, 30_000);
});
