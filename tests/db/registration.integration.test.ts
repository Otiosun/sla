import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RegistrationService } from "../../src/modules/registration/service.js";
import { runMigrations } from "../../src/platform/db/migrations.js";
import { PostgresRegistrationRepository } from "../../src/platform/registration/postgres-registration-repository.js";
import { createPlayerId } from "../../src/shared-kernel/ids.js";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (value === undefined)
    throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  return value;
})();

const REGION_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_FORM_ID = "22222222-2222-4222-8222-222222222222";

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function snapshot(name = "Liora Vale") {
  return {
    trainerName: name,
    age: 17,
    genderPronouns: "ela/dela",
    appearance: "Cabelos negros e casaco de viagem.",
    personality: "Curiosa, cautelosa e competitiva.",
    backstory: "Saiu de casa para pesquisar Pokémon raros.",
    starterFormId: STARTER_FORM_ID,
    regionId: REGION_ID,
    schemaVersion: 1,
  } as const;
}

async function expectPgCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected PostgreSQL error code ${expectedCode}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Expected PostgreSQL error code ${expectedCode}`
    ) {
      throw error;
    }
    expect(error).toMatchObject({ code: expectedCode });
  }
}

describe.sequential("registration persistence on disposable PostgreSQL", () => {
  const dbName = `pokemon_registration_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: databaseUrlFor(dbName), max: 8 });
    await runMigrations(pool, { appliedBy: "registration-vitest" });
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

  it("persists one draft per player with optimistic revision and durable review decisions", async () => {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);

    const repository = new PostgresRegistrationRepository(pool);
    const service = new RegistrationService(repository);

    const saved = await service.saveDraft({ playerId, draft: snapshot(), expectedRevision: null });
    expect(saved).toMatchObject({ ok: true, value: { revision: 0 } });

    const stale = await service.saveDraft({
      playerId,
      draft: snapshot("Stale"),
      expectedRevision: null,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });

    const submitted = await service.submit({ playerId, idempotencyKey: "db-submit-1" });
    expect(submitted).toMatchObject({
      ok: true,
      value: { sequenceNo: 1, status: "SUBMITTED", replayed: false },
    });
    if (!submitted.ok) throw submitted.error;

    const replay = await service.submit({ playerId, idempotencyKey: "db-submit-1" });
    expect(replay).toMatchObject({
      ok: true,
      value: { id: submitted.value.id, sequenceNo: 1, replayed: true },
    });

    const approved = await service.approve({
      reviewId: submitted.value.id,
      expectedRevision: submitted.value.revision,
      actor: { adminPrincipalId: "00000000-0000-4000-8000-000000000777" },
      idempotencyKey: "db-approve-1",
    });
    expect(approved).toMatchObject({
      ok: true,
      value: {
        status: "APPROVED",
        revision: 1,
        decidedByAdminPrincipalId: "00000000-0000-4000-8000-000000000777",
      },
    });
  });

  it("enforces unique player sequence and immutable submitted snapshots at the database boundary", async () => {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    const firstId = randomUUID();
    const secondId = randomUUID();

    await pool.query(
      `INSERT INTO registration_revisions(
         id, player_id, sequence_no, status, schema_version, snapshot_json, revision
       ) VALUES ($1, $2, 1, 'SUBMITTED', 1, $3::jsonb, 0)`,
      [firstId, playerId, JSON.stringify(snapshot())],
    );

    await expectPgCode(
      pool.query(
        `INSERT INTO registration_revisions(
           id, player_id, sequence_no, status, schema_version, snapshot_json, revision
         ) VALUES ($1, $2, 1, 'SUBMITTED', 1, $3::jsonb, 0)`,
        [secondId, playerId, JSON.stringify(snapshot("Duplicate"))],
      ),
      "23505",
    );

    await expectPgCode(
      pool.query("UPDATE registration_revisions SET snapshot_json = $2::jsonb WHERE id = $1", [
        firstId,
        JSON.stringify(snapshot("Mutated")),
      ]),
      "P0001",
    );
  });

  it("rolls back a half-written review transaction", async () => {
    const playerId = createPlayerId();
    await pool.query("INSERT INTO players(id, status) VALUES ($1, 'ACTIVE')", [playerId]);
    const repository = new PostgresRegistrationRepository(pool);
    const reviewId = randomUUID();

    await expect(
      repository.transaction(async (tx) => {
        await tx.insertRevision({ playerId, sequenceNo: 1, snapshot: snapshot() });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM registration_revisions WHERE id = $1 OR player_id = $2",
      [reviewId, playerId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });
});
