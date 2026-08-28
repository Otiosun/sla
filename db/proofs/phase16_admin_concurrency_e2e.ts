import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CCatalogDraftOperations } from "../../src/modules/admin/catalog-draft-definitions.js";
import { AdminCatalogDraftOperationService } from "../../src/modules/admin/catalog-draft-service.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { CatalogDraftService } from "../../src/modules/catalog/draft-service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresCatalogDraftRepository } from "../../src/platform/catalog/postgres-catalog-draft-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for the Phase 16 admin concurrency proof");
}

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected admin error ${code}`);
  }
}

async function attachGlobalContentEditor(pool: Pool, principalId: string): Promise<void> {
  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'CONTENT_EDITOR'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error("CONTENT_EDITOR role must be seeded");

  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    principalId,
    roleId,
  ]);
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL)`,
    [randomUUID(), principalId],
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const speciesId = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 16000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate Phase 16 proof release number");

  const nextDex = await pool.query<{ national_dex: number }>(
    `SELECT COALESCE(MAX(national_dex), 0)::int + 1 AS national_dex FROM pokemon_species`,
  );
  const nationalDex = nextDex.rows[0]?.national_dex;
  if (nationalDex === undefined || nationalDex > 65535) {
    throw new Error("Could not allocate Phase 16 proof National Dex number");
  }

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `phase16-admin-race-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 16 Admin Concurrency Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );
  await pool.query(
    `INSERT INTO pokemon_species(id, national_dex, slug)
     VALUES ($1, $2, $3)`,
    [speciesId, nationalDex, `phase16-race-${speciesId}`],
  );
  await pool.query(
    `INSERT INTO pokemon_species_revisions(
       id, content_release_id, species_id, display_name, catch_rate, base_exp, data
     ) VALUES ($1, $2, $3, 'Race Baseline', 45, 64, '{}'::jsonb)`,
    [randomUUID(), releaseId, speciesId],
  );

  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
    [
      principalA,
      `phase16:admin-race:a:${principalA}`,
      principalB,
      `phase16:admin-race:b:${principalB}`,
    ],
  );
  await attachGlobalContentEditor(pool, principalA);
  await attachGlobalContentEditor(pool, principalB);

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const admin = new AdminService(registry, adminRepository);
  const owner = new CatalogDraftService(new PostgresCatalogDraftRepository(pool));
  const catalogAdmin = new AdminCatalogDraftOperationService(
    admin,
    owner,
    new PostgresAdminOperationCompletion(pool),
  );
  registerPhase12CCatalogDraftOperations(registry, catalogAdmin);

  const prepare = async (principalId: string, displayName: string, suffix: string) => {
    const prepared = await admin.prepareMutation({
      principalId,
      operationType: "content.draft.replace",
      input: {
        releaseId,
        resourceId: speciesId,
        resource: {
          kind: "SPECIES",
          displayName,
          catchRate: 45,
          baseExp: 64,
          data: { phase16Race: suffix },
        },
      },
      reason: `Phase 16 concurrent admin edit ${suffix}`,
      expectedRevision: 0n,
      idempotencyKey: `phase16-admin-race-${suffix}-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    assert.equal(prepared.operation.status, "PENDING_CONFIRMATION");
    const confirmed = await admin.confirm(prepared.operation.id, principalId);
    assert.equal(confirmed.status, "READY");
    return confirmed;
  };

  const operationA = await prepare(principalA, "Race Winner A", "a");
  const operationB = await prepare(principalB, "Race Winner B", "b");

  const raced = await Promise.allSettled([
    admin.apply(operationA.id, principalA),
    admin.apply(operationB.id, principalB),
  ]);
  const fulfilled = raced.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<AdminService["apply"]>>> =>
      result.status === "fulfilled",
  );
  const rejected = raced.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]?.value.status, "APPLIED");
  assert.equal(rejected.length, 1);
  expectAdminCode(rejected[0]?.reason, ADMIN_ERROR_CODES.REVISION_CONFLICT);

  const winnerId = fulfilled[0]?.value.id;
  if (winnerId === undefined)
    throw new Error("Concurrent admin race produced no winner operation id");
  const loserId = winnerId === operationA.id ? operationB.id : operationA.id;
  const loserPrincipal = loserId === operationA.id ? principalA : principalB;

  const releaseState = await pool.query<{ revision: string }>(
    `SELECT revision::text FROM content_releases WHERE id = $1`,
    [releaseId],
  );
  assert.equal(releaseState.rows[0]?.revision, "1");

  const speciesState = await pool.query<{ display_name: string; data: Record<string, unknown> }>(
    `SELECT display_name, data
     FROM pokemon_species_revisions
     WHERE content_release_id = $1 AND species_id = $2`,
    [releaseId, speciesId],
  );
  assert.ok(
    speciesState.rows[0]?.display_name === "Race Winner A" ||
      speciesState.rows[0]?.display_name === "Race Winner B",
  );

  const evidence = await pool.query<{
    claims: string;
    changes: string;
    winner_status: string;
    loser_status: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM catalog_admin_operation_claims
         WHERE content_release_id = $1 AND resource_id = $2) AS claims,
       (SELECT count(*)::text
          FROM admin_operation_changes
         WHERE admin_operation_id = ANY($3::uuid[])) AS changes,
       (SELECT status FROM admin_operations WHERE id = $4) AS winner_status,
       (SELECT status FROM admin_operations WHERE id = $5) AS loser_status`,
    [releaseId, speciesId, [operationA.id, operationB.id], winnerId, loserId],
  );
  assert.deepEqual(evidence.rows[0], {
    claims: "1",
    changes: "1",
    winner_status: "APPLIED",
    loser_status: "READY",
  });

  const winnerReplay = await admin.apply(
    winnerId,
    winnerId === operationA.id ? principalA : principalB,
  );
  assert.equal(winnerReplay.id, winnerId);
  assert.equal(winnerReplay.status, "APPLIED");

  await assert.rejects(admin.apply(loserId, loserPrincipal), (error: unknown) => {
    expectAdminCode(error, ADMIN_ERROR_CODES.REVISION_CONFLICT);
    return true;
  });

  const finalEvidence = await pool.query<{ claims: string; changes: string; revision: string }>(
    `SELECT
       (SELECT count(*)::text
          FROM catalog_admin_operation_claims
         WHERE content_release_id = $1 AND resource_id = $2) AS claims,
       (SELECT count(*)::text
          FROM admin_operation_changes
         WHERE admin_operation_id = ANY($3::uuid[])) AS changes,
       (SELECT revision::text FROM content_releases WHERE id = $1) AS revision`,
    [releaseId, speciesId, [operationA.id, operationB.id]],
  );
  assert.deepEqual(finalEvidence.rows[0], { claims: "1", changes: "1", revision: "1" });

  console.log(
    "Phase 16 admin concurrency proof complete: two admins raced the same release revision; exactly one mutation won",
  );
} finally {
  await pool.end();
}
