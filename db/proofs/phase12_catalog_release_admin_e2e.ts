import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CCatalogReleaseOperations } from "../../src/modules/admin/catalog-release-definitions.js";
import { AdminCatalogReleaseOperationService } from "../../src/modules/admin/catalog-release-service.js";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { CatalogDraftService } from "../../src/modules/catalog/draft-service.js";
import { CatalogReleaseAdminService } from "../../src/modules/catalog/release-admin-service.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresCatalogDraftRepository } from "../../src/platform/catalog/postgres-catalog-draft-repository.js";
import { PostgresCatalogReleaseAdminRepository } from "../../src/platform/catalog/postgres-catalog-release-admin-repository.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

function expectAdminCode(error: unknown, code: string): void {
  if (!(error instanceof AdminError) || error.code !== code) {
    throw error instanceof Error ? error : new Error(`Expected admin error ${code}`);
  }
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected rejection ${code}`);
    },
    (error: unknown) => expectAdminCode(error, code),
  );
}

async function expectSqlState(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`${label} unexpectedly succeeded`);
    },
    (error: unknown) => {
      const actual =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { readonly code?: unknown }).code ?? "")
          : "";
      if (actual !== code) throw error;
    },
  );
}

function resultBoolean(operation: AdminOperationRecord, key: string): boolean {
  const value = operation.result?.[key];
  if (typeof value !== "boolean") throw new Error(`Admin result ${key} was not a boolean`);
  return value;
}

async function attachRole(
  pool: Pool,
  principalId: string,
  roleSlug: "CONTENT_EDITOR" | "CONTENT_PUBLISHER",
  scope: "GLOBAL" | "AREA",
): Promise<void> {
  const role = await pool.query<{ id: string }>(`SELECT id FROM admin_roles WHERE slug = $1`, [
    roleSlug,
  ]);
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error(`Missing seeded admin role ${roleSlug}`);
  await pool.query(`INSERT INTO admin_principal_roles(principal_id, role_id) VALUES ($1, $2)`, [
    principalId,
    roleId,
  ]);
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), principalId, scope, scope === "GLOBAL" ? null : randomUUID()],
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const source = await pool.query<{
    id: string;
    release_no: string;
    status: string;
  }>(
    `SELECT id, release_no::text, status
     FROM content_releases
     WHERE release_no = 1`,
  );
  const parent = source.rows[0];
  if (parent === undefined || parent.status !== "PUBLISHED") {
    throw new Error("Phase 12.23 proof requires the canonical Phase 4 release to be published");
  }

  const activeBefore = await pool.query<{ content_release_id: string }>(
    `SELECT content_release_id
     FROM content_release_pointers
     WHERE pointer_key = 'ACTIVE'`,
  );
  if (activeBefore.rows[0]?.content_release_id !== parent.id) {
    throw new Error("Canonical Phase 4 release must be ACTIVE before release lifecycle proof");
  }

  const releaseId = randomUUID();
  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (MAX(release_no) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate release number for Phase 12.23");

  const catalogRepository = new PostgresCatalogRepository(pool);
  const catalog = new CatalogService(catalogRepository);
  const cloned = await catalog.clonePublishedRelease({
    parentReleaseId: parent.id,
    newReleaseId: releaseId,
    releaseNo: BigInt(releaseNo),
    name: "Phase 12.23 Catalog Release Admin Proof",
  });
  if (!cloned.ok) throw new Error(`Could not clone proof release: ${cloned.error.code}`);

  const bulbasaur = await pool.query<{
    species_id: string;
    display_name: string;
    catch_rate: number | null;
    base_exp: number | null;
    data: Record<string, unknown>;
  }>(
    `SELECT revision.species_id, revision.display_name, revision.catch_rate,
            revision.base_exp, revision.data
     FROM pokemon_species_revisions revision
     JOIN pokemon_species species ON species.id = revision.species_id
     WHERE revision.content_release_id = $1 AND species.slug = 'bulbasaur'`,
    [releaseId],
  );
  const species = bulbasaur.rows[0];
  if (species === undefined) throw new Error("Cloned proof release did not contain Bulbasaur");

  const draftOwner = new CatalogDraftService(new PostgresCatalogDraftRepository(pool));
  const draftMutation = await draftOwner.replace({
    releaseId,
    resourceId: species.species_id,
    resource: {
      kind: "SPECIES",
      displayName: `${species.display_name} 12.23`,
      catchRate: species.catch_rate,
      baseExp: species.base_exp,
      data: { ...species.data, phase1223: true },
    },
    expectedRevision: 0n,
    idempotencyKey: `phase12-23-draft-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: "phase12.23-proof",
      reason: "Create one deterministic diff before release validation",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  if (!draftMutation.ok) {
    throw new Error(`Could not mutate cloned proof release: ${draftMutation.error.code}`);
  }
  if (draftMutation.value.afterRevision !== "1") {
    throw new Error("Proof DRAFT mutation did not advance release revision to 1");
  }

  const editorId = randomUUID();
  const publisherId = randomUUID();
  const approverId = randomUUID();
  const scopedPublisherId = randomUUID();
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE'), ($5, $6, 'ACTIVE'), ($7, $8, 'ACTIVE')`,
    [
      editorId,
      `phase12:release-editor:${editorId}`,
      publisherId,
      `phase12:release-publisher:${publisherId}`,
      approverId,
      `phase12:release-approver:${approverId}`,
      scopedPublisherId,
      `phase12:release-scoped:${scopedPublisherId}`,
    ],
  );
  await attachRole(pool, editorId, "CONTENT_EDITOR", "GLOBAL");
  await attachRole(pool, publisherId, "CONTENT_PUBLISHER", "GLOBAL");
  await attachRole(pool, approverId, "CONTENT_PUBLISHER", "GLOBAL");
  await attachRole(pool, scopedPublisherId, "CONTENT_PUBLISHER", "AREA");

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const admin = new AdminService(registry, adminRepository);
  const releaseOwner = new CatalogReleaseAdminService(
    new PostgresCatalogReleaseAdminRepository(pool),
  );
  const releaseAdmin = new AdminCatalogReleaseOperationService(
    admin,
    releaseOwner,
    new PostgresAdminOperationCompletion(pool),
  );
  registerPhase12CCatalogReleaseOperations(registry, releaseAdmin);

  const releaseDiff = await releaseAdmin.diff({
    principalId: editorId,
    fromReleaseId: parent.id,
    toReleaseId: releaseId,
  });
  const speciesDiff = releaseDiff.sections.find((section) => section.category === "species");
  if (
    speciesDiff === undefined ||
    speciesDiff.added !== 0 ||
    speciesDiff.removed !== 0 ||
    speciesDiff.changed !== 1
  ) {
    throw new Error("Release diff did not expose the single deterministic species change");
  }
  await expectRejected(
    releaseAdmin.diff({
      principalId: scopedPublisherId,
      fromReleaseId: parent.id,
      toReleaseId: releaseId,
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const staleValidate = await admin.prepareMutation({
    principalId: editorId,
    operationType: "content.release.validate",
    input: { releaseId },
    reason: "Phase 12.23 stale CAS proof",
    expectedRevision: 0n,
    idempotencyKey: `phase12-23-stale-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  await admin.confirm(staleValidate.operation.id, editorId);
  await expectRejected(
    admin.apply(staleValidate.operation.id, editorId),
    ADMIN_ERROR_CODES.REVISION_CONFLICT,
  );

  const validatePrepared = await admin.prepareMutation({
    principalId: editorId,
    operationType: "content.release.validate",
    input: { releaseId },
    reason: "Phase 12.23 validate release",
    expectedRevision: 1n,
    idempotencyKey: `phase12-23-validate-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (validatePrepared.operation.status !== "PENDING_CONFIRMATION") {
    throw new Error("R3 release validation did not require explicit confirmation");
  }
  await expectRejected(
    admin.apply(validatePrepared.operation.id, editorId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  const validateReady = await admin.confirm(validatePrepared.operation.id, editorId);
  if (validateReady.status !== "READY") {
    throw new Error("Confirmed R3 release validation did not become READY");
  }

  const ownerValidate = await releaseOwner.validate({
    releaseId,
    expectedRevision: 1n,
    idempotencyKey: validatePrepared.operation.id,
    correlationId: validatePrepared.operation.correlationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: validatePrepared.operation.id,
      reason: validatePrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: validatePrepared.operation.principalId,
    },
  });
  if (!ownerValidate.ok || ownerValidate.value.replayed) {
    throw new Error("Owner-side validate crash-window setup did not commit exactly once");
  }
  const validateApplied = await admin.apply(validatePrepared.operation.id, editorId);
  if (validateApplied.status !== "APPLIED" || !resultBoolean(validateApplied, "ownerReplayed")) {
    throw new Error("Admin validate did not recover from committed owner claim by replay");
  }
  const validateAppliedAgain = await admin.apply(validatePrepared.operation.id, editorId);
  if (
    validateAppliedAgain.id !== validateApplied.id ||
    validateAppliedAgain.revision !== validateApplied.revision
  ) {
    throw new Error("Applied validate retry was not stable");
  }

  await expectRejected(
    admin.prepareMutation({
      principalId: editorId,
      operationType: "content.release.publish",
      input: { releaseId },
      reason: "Editors must not publish",
      expectedRevision: 1n,
      idempotencyKey: `phase12-23-editor-publish-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );
  await expectRejected(
    admin.prepareMutation({
      principalId: scopedPublisherId,
      operationType: "content.release.publish",
      input: { releaseId },
      reason: "Scoped publisher must not publish global content",
      expectedRevision: 1n,
      idempotencyKey: `phase12-23-scoped-publish-${randomUUID()}`,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  const publishPrepared = await admin.prepareMutation({
    principalId: publisherId,
    operationType: "content.release.publish",
    input: { releaseId },
    reason: "Phase 12.23 publish release",
    expectedRevision: 1n,
    idempotencyKey: `phase12-23-publish-${randomUUID()}`,
    correlationId: randomUUID(),
  });
  if (publishPrepared.operation.status !== "VALIDATED") {
    throw new Error("R4 release publish did not enter simulation gate");
  }
  await expectRejected(
    admin.apply(publishPrepared.operation.id, publisherId),
    ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
  );
  const simulated = await admin.simulate(publishPrepared.operation.id, publisherId);
  if (simulated.status !== "PENDING_CONFIRMATION") {
    throw new Error("Release publish simulation did not require proposer confirmation");
  }
  const simulation = simulated.result?.simulation;
  if (simulation === null || typeof simulation !== "object") {
    throw new Error("Release publish simulation was not persisted on the operation result");
  }
  const summary = (simulation as Record<string, unknown>).summary;
  if (
    summary === null ||
    typeof summary !== "object" ||
    (summary as Record<string, unknown>).releaseId !== releaseId
  ) {
    throw new Error("Release publish simulation did not persist the expected preview");
  }

  const publishConfirmed = await admin.confirm(publishPrepared.operation.id, publisherId);
  if (publishConfirmed.status !== "PENDING_APPROVAL") {
    throw new Error("Confirmed R4 publish did not enter independent approval gate");
  }
  await expectRejected(
    admin.approve(publishPrepared.operation.id, publisherId, "self approval must fail"),
    ADMIN_ERROR_CODES.SELF_APPROVAL_FORBIDDEN,
  );
  await expectRejected(
    admin.approve(publishPrepared.operation.id, scopedPublisherId, "scoped approval must fail"),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );
  const publishReady = await admin.approve(
    publishPrepared.operation.id,
    approverId,
    "Independent approval for Phase 12.23 PostgreSQL proof",
  );
  if (publishReady.status !== "READY") {
    throw new Error("Independent R4 approval did not make publish READY");
  }

  const ownerPublish = await releaseOwner.publish({
    releaseId,
    expectedRevision: 1n,
    idempotencyKey: publishPrepared.operation.id,
    correlationId: publishPrepared.operation.correlationId,
    metadata: {
      sourceType: "ADMIN_OPERATION",
      sourceId: publishPrepared.operation.id,
      reason: publishPrepared.operation.reason ?? "",
      actorType: "ADMIN",
      actorId: publishPrepared.operation.principalId,
    },
  });
  if (!ownerPublish.ok || ownerPublish.value.replayed) {
    throw new Error("Owner-side publish crash-window setup did not commit exactly once");
  }
  const publishApplied = await admin.apply(publishPrepared.operation.id, publisherId);
  if (publishApplied.status !== "APPLIED" || !resultBoolean(publishApplied, "ownerReplayed")) {
    throw new Error("Admin publish did not recover from committed owner claim by replay");
  }

  const finalRelease = await pool.query<{ status: string; revision: string }>(
    `SELECT status, revision::text FROM content_releases WHERE id = $1`,
    [releaseId],
  );
  if (finalRelease.rows[0]?.status !== "PUBLISHED" || finalRelease.rows[0]?.revision !== "1") {
    throw new Error("Published release did not preserve its validated content revision");
  }
  const activeAfter = await pool.query<{ content_release_id: string }>(
    `SELECT content_release_id FROM content_release_pointers WHERE pointer_key = 'ACTIVE'`,
  );
  if (activeAfter.rows[0]?.content_release_id !== parent.id) {
    throw new Error("Publishing a content release incorrectly changed the ACTIVE pointer");
  }

  const postPublishMutation = await draftOwner.replace({
    releaseId,
    resourceId: species.species_id,
    resource: {
      kind: "SPECIES",
      displayName: "Forbidden published edit",
      catchRate: species.catch_rate,
      baseExp: species.base_exp,
      data: {},
    },
    expectedRevision: 1n,
    idempotencyKey: `phase12-23-post-publish-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: "phase12.23-proof",
      reason: "Published releases must be immutable",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  if (postPublishMutation.ok || postPublishMutation.error.code !== "INVALID_STATE_TRANSITION") {
    throw new Error("Published release still accepted DRAFT catalog mutation");
  }

  const claimCounts = await pool.query<{ claims: string }>(
    `SELECT count(*)::text AS claims
     FROM catalog_release_admin_operation_claims
     WHERE idempotency_key = ANY($1::text[])`,
    [[validatePrepared.operation.id, publishPrepared.operation.id]],
  );
  if (claimCounts.rows[0]?.claims !== "2") {
    throw new Error("Release lifecycle owner did not persist exactly one claim per mutation");
  }

  const evidence = await pool.query<{
    changes: string;
    confirmations: string;
    approvals: string;
    validate_audits: string;
    publish_audits: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM admin_operation_changes
        WHERE admin_operation_id = ANY($1::uuid[])) AS changes,
       (SELECT count(*)::text FROM admin_operation_confirmations
        WHERE admin_operation_id = ANY($1::uuid[])) AS confirmations,
       (SELECT count(*)::text FROM admin_operation_approvals
        WHERE admin_operation_id = $2) AS approvals,
       (SELECT count(*)::text FROM audit_events
        WHERE actor_id = $3 AND action = 'content.release.validate') AS validate_audits,
       (SELECT count(*)::text FROM audit_events
        WHERE actor_id = $4 AND action = 'content.release.publish') AS publish_audits`,
    [
      [validatePrepared.operation.id, publishPrepared.operation.id],
      publishPrepared.operation.id,
      editorId,
      publisherId,
    ],
  );
  const evidenceRow = evidence.rows[0];
  if (
    evidenceRow?.changes !== "2" ||
    evidenceRow.confirmations !== "2" ||
    evidenceRow.approvals !== "1" ||
    evidenceRow.validate_audits !== "1" ||
    evidenceRow.publish_audits !== "1"
  ) {
    throw new Error("Release lifecycle Admin Registry evidence is incomplete");
  }

  await expectSqlState(
    pool.query(
      `UPDATE catalog_release_admin_operation_claims
       SET after_status = before_status
       WHERE idempotency_key = $1`,
      [validatePrepared.operation.id],
    ),
    "55000",
    "Catalog release claim UPDATE",
  );
  await expectSqlState(
    pool.query(`DELETE FROM catalog_release_admin_operation_claims WHERE idempotency_key = $1`, [
      publishPrepared.operation.id,
    ]),
    "55000",
    "Catalog release claim DELETE",
  );

  console.log("phase12 catalog release admin proof passed");
} finally {
  await pool.end();
}
