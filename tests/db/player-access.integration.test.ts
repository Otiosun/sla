import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresPlayerAccessRepository } from "../../src/platform/registration/postgres-player-access-repository.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

const ADMIN_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000778";
const SNAPSHOT = {
  trainerName: "Liora Vale",
  age: 17,
  genderPronouns: "ela/dela",
  appearance: "Cabelos negros e casaco de viagem.",
  personality: "Curiosa, cautelosa e competitiva.",
  backstory: "Saiu de casa para pesquisar Pokémon raros.",
  starterFormId: "22222222-2222-4222-8222-222222222222",
  regionId: "11111111-1111-4111-8111-111111111111",
  schemaVersion: 1,
} as const;

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe.sequential("player access persistence on disposable PostgreSQL", () => {
  const dbName = `pokemon_player_access_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "player-access-vitest" });
    await pool.query(
      `INSERT INTO admin_principals(id, identity_ref, status)
       VALUES ($1, 'player-access-test-admin', 'ACTIVE')`,
      [ADMIN_PRINCIPAL_ID],
    );
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

  async function createApprovedReview(): Promise<{ readonly playerId: ReturnType<typeof createPlayerId>; readonly reviewId: string }> {
    const playerId = createPlayerId();
    const reviewId = randomUUID();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    await pool.query(
      `INSERT INTO registration_revisions(
         id, player_id, sequence_no, status, schema_version, snapshot_json, revision,
         decided_by_admin_principal_id, decided_at
       ) VALUES ($1, $2, 1, 'APPROVED', 1, $3::jsonb, 1, $4, now())`,
      [reviewId, playerId, JSON.stringify(SNAPSHOT), ADMIN_PRINCIPAL_ID],
    );
    return { playerId, reviewId };
  }

  it("materializes PENDING as PROVISIONING and activates only with the expected revision", async () => {
    const { playerId, reviewId } = await createApprovedReview();
    const repository = new PostgresPlayerAccessRepository(pool);

    const pending = await repository.read((tx) => tx.load(playerId));
    expect(pending).toEqual({
      playerId,
      status: "PENDING",
      approvedReviewId: null,
      revision: 0,
    });

    const provisioning = await repository.transaction((tx) =>
      tx.beginProvisioning({ playerId, reviewId, expectedRevision: pending.revision }),
    );
    expect(provisioning).toEqual({
      playerId,
      status: "PROVISIONING",
      approvedReviewId: reviewId,
      revision: 1,
    });

    const staleActivation = await repository.transaction((tx) =>
      tx.activate({ playerId, reviewId, expectedRevision: 0 }),
    );
    expect(staleActivation).toBeNull();

    const active = await repository.transaction((tx) =>
      tx.activate({ playerId, reviewId, expectedRevision: 1 }),
    );
    expect(active).toEqual({
      playerId,
      status: "ACTIVE",
      approvedReviewId: reviewId,
      revision: 2,
    });
  });

  it("suspends and restores without deleting the approved review binding", async () => {
    const { playerId, reviewId } = await createApprovedReview();
    const repository = new PostgresPlayerAccessRepository(pool);

    const provisioning = await repository.transaction((tx) =>
      tx.beginProvisioning({ playerId, reviewId, expectedRevision: 0 }),
    );
    if (provisioning === null) throw new Error("Expected provisioning transition");
    const active = await repository.transaction((tx) =>
      tx.activate({ playerId, reviewId, expectedRevision: provisioning.revision }),
    );
    if (active === null) throw new Error("Expected active transition");

    const suspended = await repository.transaction((tx) =>
      tx.suspend({ playerId, expectedRevision: active.revision }),
    );
    expect(suspended).toEqual({
      playerId,
      status: "SUSPENDED",
      approvedReviewId: reviewId,
      revision: 3,
    });

    const restored = await repository.transaction((tx) =>
      tx.restore({ playerId, expectedRevision: suspended?.revision ?? -1 }),
    );
    expect(restored).toEqual({
      playerId,
      status: "ACTIVE",
      approvedReviewId: reviewId,
      revision: 4,
    });
  });

  it("rolls back access state when the surrounding transaction fails", async () => {
    const { playerId, reviewId } = await createApprovedReview();
    const repository = new PostgresPlayerAccessRepository(pool);

    await expect(
      repository.transaction(async (tx) => {
        const changed = await tx.beginProvisioning({ playerId, reviewId, expectedRevision: 0 });
        expect(changed?.status).toBe("PROVISIONING");
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await repository.read((tx) => tx.load(playerId))).toEqual({
      playerId,
      status: "PENDING",
      approvedReviewId: null,
      revision: 0,
    });
  });
});
