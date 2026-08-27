import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { registerPhase12CCatalogDraftOperations } from "../../src/modules/admin/catalog-draft-definitions.js";
import { AdminCatalogDraftOperationService } from "../../src/modules/admin/catalog-draft-service.js";
import type { AdminOperationRecord } from "../../src/modules/admin/contracts.js";
import { createPhase12AdminOperationRegistry } from "../../src/modules/admin/definitions.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../src/modules/admin/errors.js";
import { AdminService } from "../../src/modules/admin/service.js";
import { CatalogDraftService } from "../../src/modules/catalog/draft-service.js";
import { CatalogService } from "../../src/modules/catalog/service.js";
import { PostgresAdminOperationCompletion } from "../../src/platform/admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../../src/platform/admin/postgres-admin-repository.js";
import { PostgresCatalogDraftRepository } from "../../src/platform/catalog/postgres-catalog-draft-repository.js";
import { PostgresCatalogRepository } from "../../src/platform/catalog/postgres-catalog-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");

const OPEN_CONDITIONS = {
  schemaVersion: 1 as const,
  requiredUnlockKeys: [] as string[],
  blockedUnlockKeys: [] as string[],
};

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

function expectOwnerCode(
  result: { readonly ok: boolean; readonly error?: { readonly code?: string } },
  code: string,
  label: string,
): void {
  if (result.ok) throw new Error(`${label} unexpectedly succeeded`);
  if (result.error?.code !== code) {
    throw new Error(`${label} returned ${String(result.error?.code)} instead of ${code}`);
  }
}

async function expectSqlState(promise: Promise<unknown>, code: string, label: string): Promise<void> {
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

function resultString(operation: AdminOperationRecord, key: string): string {
  const value = operation.result?.[key];
  if (typeof value !== "string") {
    throw new Error(`Admin result ${key} was not a string`);
  }
  return value;
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
try {
  const rulesetId = randomUUID();
  const releaseId = randomUUID();
  const typeId = randomUUID();
  const regionId = randomUUID();
  const currencyId = randomUUID();
  const globalPrincipalId = randomUUID();
  const scopedPrincipalId = randomUUID();

  const nextRelease = await pool.query<{ release_no: string }>(
    `SELECT (COALESCE(MAX(release_no), 970000) + 1)::text AS release_no FROM content_releases`,
  );
  const releaseNo = nextRelease.rows[0]?.release_no;
  if (releaseNo === undefined) throw new Error("Could not allocate catalog admin proof release");

  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [rulesetId, `phase12-catalog-admin-${rulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Catalog Draft Admin Proof', 'DRAFT', $3)`,
    [releaseId, releaseNo, rulesetId],
  );

  await pool.query(`INSERT INTO pokemon_types(id, slug) VALUES ($1, $2)`, [
    typeId,
    `phase12-catalog-type-${typeId}`,
  ]);
  await pool.query(
    `INSERT INTO pokemon_type_revisions(id, content_release_id, type_id, display_name, active, data)
     VALUES ($1, $2, $3, 'Proof Type', TRUE, '{}'::jsonb)`,
    [randomUUID(), releaseId, typeId],
  );
  await pool.query(`INSERT INTO regions(id, slug) VALUES ($1, $2)`, [
    regionId,
    `phase12-catalog-region-${regionId}`,
  ]);
  await pool.query(
    `INSERT INTO region_revisions(id, content_release_id, region_id, display_name, active, data)
     VALUES ($1, $2, $3, 'Proof Region', TRUE, '{}'::jsonb)`,
    [randomUUID(), releaseId, regionId],
  );
  await pool.query(
    `INSERT INTO currency_definitions(id, slug, display_name, allows_negative)
     VALUES ($1, $2, 'Proof Currency', FALSE)`,
    [currencyId, `phase12-catalog-currency-${currencyId}`],
  );

  const contentEditor = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE slug = 'CONTENT_EDITOR'`,
  );
  const contentEditorRoleId = contentEditor.rows[0]?.id;
  if (contentEditorRoleId === undefined) {
    throw new Error("Catalog admin proof requires seeded CONTENT_EDITOR role");
  }
  await pool.query(
    `INSERT INTO admin_principals(id, identity_ref, status)
     VALUES ($1, $2, 'ACTIVE'), ($3, $4, 'ACTIVE')`,
    [
      globalPrincipalId,
      `phase12:catalog-global:${globalPrincipalId}`,
      scopedPrincipalId,
      `phase12:catalog-scoped:${scopedPrincipalId}`,
    ],
  );
  await pool.query(
    `INSERT INTO admin_principal_roles(principal_id, role_id)
     VALUES ($1, $2), ($3, $2)`,
    [globalPrincipalId, contentEditorRoleId, scopedPrincipalId],
  );
  await pool.query(
    `INSERT INTO admin_principal_scopes(id, principal_id, scope_type, scope_id)
     VALUES ($1, $2, 'GLOBAL', NULL), ($3, $4, 'AREA', $5)`,
    [randomUUID(), globalPrincipalId, randomUUID(), scopedPrincipalId, randomUUID()],
  );

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const admin = new AdminService(registry, adminRepository);
  const draftOwner = new CatalogDraftService(new PostgresCatalogDraftRepository(pool));
  const catalogAdmin = new AdminCatalogDraftOperationService(
    admin,
    draftOwner,
    new PostgresAdminOperationCompletion(pool),
  );
  registerPhase12CCatalogDraftOperations(registry, catalogAdmin);

  let releaseRevision = 0n;
  let firstMutation = true;
  const appliedOperationIds: string[] = [];

  async function applyMutation(input: {
    readonly operationType:
      | "content.draft.create"
      | "content.draft.replace"
      | "content.draft.deactivate";
    readonly payload: Readonly<Record<string, unknown>>;
    readonly expectedRevision?: bigint;
    readonly idempotencyKey?: string;
  }): Promise<AdminOperationRecord> {
    const expectedRevision = input.expectedRevision ?? releaseRevision;
    const prepared = await admin.prepareMutation({
      principalId: globalPrincipalId,
      operationType: input.operationType,
      input: input.payload,
      reason: "Phase 12.22 catalog draft PostgreSQL proof",
      expectedRevision,
      idempotencyKey: input.idempotencyKey ?? `catalog-admin-${randomUUID()}`,
      correlationId: randomUUID(),
    });
    if (prepared.operation.status !== "PENDING_CONFIRMATION") {
      throw new Error(`${input.operationType} did not require explicit R3 confirmation`);
    }
    if (firstMutation) {
      firstMutation = false;
      await expectRejected(
        admin.apply(prepared.operation.id, globalPrincipalId),
        ADMIN_ERROR_CODES.INVALID_OPERATION_STATE,
      );
    }
    await admin.confirm(prepared.operation.id, globalPrincipalId);
    const applied = await admin.apply(prepared.operation.id, globalPrincipalId);
    if (applied.status !== "APPLIED") {
      throw new Error(`${input.operationType} did not complete through Admin Registry`);
    }
    const beforeRevision = BigInt(resultString(applied, "beforeRevision"));
    const afterRevision = BigInt(resultString(applied, "afterRevision"));
    if (beforeRevision !== expectedRevision || afterRevision !== expectedRevision + 1n) {
      throw new Error(`${input.operationType} did not advance release revision exactly once`);
    }
    releaseRevision = afterRevision;
    appliedOperationIds.push(applied.id);
    return applied;
  }

  const nextDex = await pool.query<{ national_dex: number }>(
    `SELECT COALESCE(MAX(national_dex), 0)::int + 1 AS national_dex FROM pokemon_species`,
  );
  const nationalDex = nextDex.rows[0]?.national_dex;
  if (nationalDex === undefined || nationalDex > 65535) {
    throw new Error("Could not allocate proof National Dex number");
  }

  const speciesAdminIdempotency = `catalog-species-create-${randomUUID()}`;
  const speciesCreated = await applyMutation({
    operationType: "content.draft.create",
    idempotencyKey: speciesAdminIdempotency,
    payload: {
      releaseId,
      resource: {
        kind: "SPECIES",
        slug: `phase12-proof-species-${randomUUID()}`,
        nationalDex,
        displayName: "Proof Species",
        catchRate: 45,
        baseExp: 64,
        data: {},
      },
    },
  });
  const speciesId = resultString(speciesCreated, "resourceId");

  await expectRejected(
    admin.prepareMutation({
      principalId: globalPrincipalId,
      operationType: "content.draft.create",
      input: {
        releaseId,
        resource: {
          kind: "SPECIES",
          slug: `phase12-proof-species-drift-${randomUUID()}`,
          nationalDex,
          displayName: "Semantic drift",
          catchRate: 45,
          baseExp: 64,
          data: {},
        },
      },
      reason: "Phase 12.22 catalog draft PostgreSQL proof",
      expectedRevision: 0n,
      idempotencyKey: speciesAdminIdempotency,
      correlationId: randomUUID(),
    }),
    ADMIN_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );

  const formId = randomUUID();
  await pool.query(`INSERT INTO pokemon_forms(id, species_id, slug) VALUES ($1, $2, $3)`, [
    formId,
    speciesId,
    `phase12-proof-form-${formId}`,
  ]);

  const moveCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "MOVE",
        slug: `phase12-proof-move-${randomUUID()}`,
        displayName: "Proof Move",
        typeId,
        category: "PHYSICAL",
        power: 40,
        accuracy: 100,
        priority: 0,
        maxPp: 35,
        effectKey: null,
        effectConfig: {},
        flags: {},
      },
    },
  });
  const moveId = resultString(moveCreated, "resourceId");

  const itemCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "ITEM",
        slug: `phase12-proof-item-${randomUUID()}`,
        displayName: "Proof Item",
        itemKind: "HELD",
        effectKey: null,
        effectConfig: {},
      },
    },
  });
  const itemId = resultString(itemCreated, "resourceId");

  const areaCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "AREA",
        regionId,
        slug: `phase12-proof-area-${randomUUID()}`,
        displayName: "Proof Area",
        data: {},
      },
    },
  });
  const areaId = resultString(areaCreated, "resourceId");

  const effectCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "EFFECT",
        slug: `phase12-proof-effect-${randomUUID()}`,
        scope: "POKEMON",
        stackingPolicy: "REPLACE",
        durationModel: "PERMANENT",
        rules: {
          version: 1,
          steps: [{ effectKey: "heal-hp", config: { amount: 1 } }],
        },
      },
    },
  });
  const effectId = resultString(effectCreated, "resourceId");

  const encounterCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "ENCOUNTER_TABLE",
        areaId,
        slug: `phase12-proof-encounter-${randomUUID()}`,
        conditions: OPEN_CONDITIONS,
        entries: [
          {
            formId,
            weight: "100",
            minLevel: 2,
            maxLevel: 4,
            active: true,
            conditions: OPEN_CONDITIONS,
          },
        ],
      },
    },
  });
  const encounterTableId = resultString(encounterCreated, "resourceId");

  const rewardCreated = await applyMutation({
    operationType: "content.draft.create",
    payload: {
      releaseId,
      resource: {
        kind: "REWARD",
        slug: `phase12-proof-reward-${randomUUID()}`,
        displayName: "Proof Reward",
        program: {
          version: 1,
          grants: [
            { kind: "ITEM", itemId, quantity: 1 },
            { kind: "CURRENCY", currencyId, amount: 25 },
            { kind: "TRAINER_POINTS", amount: 5 },
          ],
        },
      },
    },
  });
  const rewardId = resultString(rewardCreated, "resourceId");

  if (releaseRevision !== 7n) {
    throw new Error(`Seven creates advanced release to ${releaseRevision.toString()} instead of 7`);
  }

  const inspected = await catalogAdmin.inspect({
    principalId: globalPrincipalId,
    releaseId,
    resourceKind: "REWARD",
    resourceId: rewardId,
  });
  if (!inspected.active || inspected.releaseRevision !== "7") {
    throw new Error("Global catalog inspect did not return current reward state");
  }
  await expectRejected(
    catalogAdmin.inspect({
      principalId: scopedPrincipalId,
      releaseId,
      resourceKind: "REWARD",
      resourceId: rewardId,
    }),
    ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
  );

  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: speciesId,
      resource: {
        kind: "SPECIES",
        displayName: "Proof Species v2",
        catchRate: 46,
        baseExp: 65,
        data: { proof: 2 },
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: moveId,
      resource: {
        kind: "MOVE",
        displayName: "Proof Move v2",
        typeId,
        category: "PHYSICAL",
        power: 50,
        accuracy: 95,
        priority: 0,
        maxPp: 30,
        effectKey: null,
        effectConfig: {},
        flags: { schemaVersion: 1, makesContact: true },
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: itemId,
      resource: {
        kind: "ITEM",
        displayName: "Proof Item v2",
        itemKind: "HELD",
        effectKey: null,
        effectConfig: {},
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: areaId,
      resource: {
        kind: "AREA",
        displayName: "Proof Area v2",
        data: { proof: 2 },
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: effectId,
      resource: {
        kind: "EFFECT",
        scope: "POKEMON",
        stackingPolicy: "REFRESH",
        durationModel: "PERMANENT",
        rules: {
          version: 1,
          steps: [{ effectKey: "heal-hp", config: { amount: 2 } }],
        },
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: encounterTableId,
      resource: {
        kind: "ENCOUNTER_TABLE",
        conditions: OPEN_CONDITIONS,
        entries: [
          {
            formId,
            weight: "250",
            minLevel: 5,
            maxLevel: 7,
            active: true,
            conditions: OPEN_CONDITIONS,
          },
        ],
      },
    },
  });
  await applyMutation({
    operationType: "content.draft.replace",
    payload: {
      releaseId,
      resourceId: rewardId,
      resource: {
        kind: "REWARD",
        displayName: "Proof Reward v2",
        program: {
          version: 1,
          grants: [
            { kind: "ITEM", itemId, quantity: 2 },
            { kind: "CURRENCY", currencyId, amount: 50 },
          ],
        },
      },
    },
  });

  if (releaseRevision !== 14n) {
    throw new Error(`Seven replacements advanced release to ${releaseRevision.toString()} instead of 14`);
  }

  const replacedEntries = await pool.query<{ count: string; weight: string }>(
    `SELECT count(*)::text AS count, max(weight)::text AS weight
     FROM encounter_entries entry
     JOIN encounter_table_revisions revision
       ON revision.id = entry.encounter_table_revision_id
     WHERE revision.content_release_id = $1 AND revision.encounter_table_id = $2`,
    [releaseId, encounterTableId],
  );
  if (replacedEntries.rows[0]?.count !== "1" || replacedEntries.rows[0]?.weight !== "250") {
    throw new Error("Encounter table replace did not atomically replace revision-local entries");
  }

  for (const [resourceKind, resourceId] of [
    ["REWARD", rewardId],
    ["ENCOUNTER_TABLE", encounterTableId],
    ["MOVE", moveId],
    ["ITEM", itemId],
    ["EFFECT", effectId],
    ["SPECIES", speciesId],
    ["AREA", areaId],
  ] as const) {
    await applyMutation({
      operationType: "content.draft.deactivate",
      payload: { releaseId, resourceKind, resourceId },
    });
  }

  if (releaseRevision !== 21n) {
    throw new Error(`Seven deactivations advanced release to ${releaseRevision.toString()} instead of 21`);
  }

  const catalogRepository = new PostgresCatalogRepository(pool);
  const snapshot = await catalogRepository.read((transaction) =>
    transaction.loadCatalogSnapshot(releaseId),
  );
  const snapshotReward = snapshot?.rewards?.find((entry) => entry.rewardId === rewardId);
  if (snapshotReward === undefined || snapshotReward.active) {
    throw new Error("Catalog snapshot did not include the deactivated versioned reward");
  }

  const replayKey = `catalog-owner-replay-${randomUUID()}`;
  const replayCorrelationId = randomUUID();
  const replaySourceId = randomUUID();
  const replayInput = {
    releaseId,
    resource: {
      kind: "EFFECT" as const,
      slug: `phase12-proof-replay-effect-${randomUUID()}`,
      scope: "POKEMON" as const,
      stackingPolicy: "REPLACE",
      durationModel: "PERMANENT",
      rules: {
        version: 1 as const,
        steps: [{ effectKey: "heal-hp", config: { amount: 3 } }],
      },
    },
    expectedRevision: releaseRevision,
    idempotencyKey: replayKey,
    correlationId: replayCorrelationId,
    metadata: {
      sourceType: "SYSTEM" as const,
      sourceId: replaySourceId,
      reason: "Catalog owner replay proof",
      actorType: "SYSTEM" as const,
      actorId: null,
    },
  };
  const firstOwnerApply = await draftOwner.create(replayInput);
  if (!firstOwnerApply.ok || firstOwnerApply.value.replayed) {
    throw new Error("Initial catalog owner replay fixture did not persist exactly once");
  }
  const replayResourceId = firstOwnerApply.value.resourceId;
  releaseRevision = BigInt(firstOwnerApply.value.afterRevision);
  const secondOwnerApply = await draftOwner.create(replayInput);
  if (
    !secondOwnerApply.ok ||
    !secondOwnerApply.value.replayed ||
    secondOwnerApply.value.resourceId !== replayResourceId ||
    BigInt(secondOwnerApply.value.afterRevision) !== releaseRevision
  ) {
    throw new Error("Catalog owner idempotent replay did not return original durable evidence");
  }
  const driftedReplay = await draftOwner.create({
    ...replayInput,
    resource: { ...replayInput.resource, stackingPolicy: "REFRESH" },
  });
  expectOwnerCode(driftedReplay, "FINGERPRINT_MISMATCH", "Catalog owner semantic drift");

  const staleDeactivate = await draftOwner.deactivate({
    releaseId,
    resourceKind: "EFFECT",
    resourceId: replayResourceId,
    expectedRevision: releaseRevision - 1n,
    idempotencyKey: `catalog-owner-stale-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: randomUUID(),
      reason: "Catalog stale revision proof",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  expectOwnerCode(staleDeactivate, "REVISION_CONFLICT", "Catalog stale revision mutation");

  const invalidRewardItem = await draftOwner.create({
    releaseId,
    resource: {
      kind: "REWARD",
      slug: `phase12-proof-invalid-item-reward-${randomUUID()}`,
      displayName: "Invalid Item Reward",
      program: {
        version: 1,
        grants: [{ kind: "ITEM", itemId: randomUUID(), quantity: 1 }],
      },
    },
    expectedRevision: releaseRevision,
    idempotencyKey: `catalog-invalid-item-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: randomUUID(),
      reason: "Reject invalid reward item reference",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  expectOwnerCode(invalidRewardItem, "VALIDATION_FAILED", "Invalid reward item reference");

  const invalidRewardCurrency = await draftOwner.create({
    releaseId,
    resource: {
      kind: "REWARD",
      slug: `phase12-proof-invalid-currency-reward-${randomUUID()}`,
      displayName: "Invalid Currency Reward",
      program: {
        version: 1,
        grants: [{ kind: "CURRENCY", currencyId: randomUUID(), amount: 1 }],
      },
    },
    expectedRevision: releaseRevision,
    idempotencyKey: `catalog-invalid-currency-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: randomUUID(),
      reason: "Reject invalid reward currency reference",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  expectOwnerCode(
    invalidRewardCurrency,
    "VALIDATION_FAILED",
    "Invalid reward currency reference",
  );

  const revisionEvidence = await pool.query<{ revision: string }>(
    `SELECT revision::text FROM content_releases WHERE id = $1`,
    [releaseId],
  );
  if (revisionEvidence.rows[0]?.revision !== releaseRevision.toString()) {
    throw new Error("Rejected/replayed catalog mutations changed release revision unexpectedly");
  }

  const claimEvidence = await pool.query<{ count: string; first_id: string | null }>(
    `SELECT count(*)::text AS count, min(id::text) AS first_id
     FROM catalog_admin_operation_claims
     WHERE content_release_id = $1`,
    [releaseId],
  );
  if (BigInt(claimEvidence.rows[0]?.count ?? "0") < 22n) {
    throw new Error("Catalog owner claims are missing successful mutation evidence");
  }
  const firstClaimId = claimEvidence.rows[0]?.first_id;
  if (firstClaimId === null || firstClaimId === undefined) {
    throw new Error("Catalog owner claim proof could not select evidence row");
  }
  await expectSqlState(
    pool.query(
      `UPDATE catalog_admin_operation_claims SET result = result WHERE id = $1`,
      [firstClaimId],
    ),
    "55000",
    "Catalog owner claim update",
  );

  const adminEvidence = await pool.query<{
    changes: string;
    confirmations: string;
    audits: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM admin_operation_changes change
        JOIN admin_operations operation ON operation.id = change.admin_operation_id
        WHERE operation.principal_id = $1
          AND operation.operation_type IN (
            'content.draft.create', 'content.draft.replace', 'content.draft.deactivate'
          )) AS changes,
       (SELECT count(*)::text
        FROM admin_operation_confirmations confirmation
        JOIN admin_operations operation ON operation.id = confirmation.admin_operation_id
        WHERE operation.principal_id = $1
          AND operation.operation_type IN (
            'content.draft.create', 'content.draft.replace', 'content.draft.deactivate'
          )) AS confirmations,
       (SELECT count(*)::text
        FROM audit_events
        WHERE actor_id = $1
          AND action IN ('content.draft.create', 'content.draft.replace', 'content.draft.deactivate')) AS audits`,
    [globalPrincipalId],
  );
  if (
    adminEvidence.rows[0]?.changes !== "21" ||
    adminEvidence.rows[0]?.confirmations !== "21" ||
    adminEvidence.rows[0]?.audits !== "21" ||
    appliedOperationIds.length !== 21
  ) {
    throw new Error("Catalog admin mutations did not produce one confirmation/change/audit each");
  }

  const parentRulesetId = randomUUID();
  const parentReleaseId = randomUUID();
  const childReleaseId = randomUUID();
  const parentItemId = randomUUID();
  const parentRewardId = randomUUID();
  const parentReleaseNo = (BigInt(releaseNo) + 1n).toString();
  const childReleaseNo = BigInt(releaseNo) + 2n;
  await pool.query(
    `INSERT INTO rulesets(id, key, version, engine_contract_version, config, status)
     VALUES ($1, $2, 1, 1, '{}'::jsonb, 'DRAFT')`,
    [parentRulesetId, `phase12-catalog-clone-${parentRulesetId}`],
  );
  await pool.query(
    `INSERT INTO content_releases(id, release_no, name, status, default_ruleset_id)
     VALUES ($1, $2, 'Phase 12 Reward Clone Parent', 'DRAFT', $3)`,
    [parentReleaseId, parentReleaseNo, parentRulesetId],
  );
  await pool.query(`INSERT INTO items(id, slug) VALUES ($1, $2)`, [
    parentItemId,
    `phase12-clone-item-${parentItemId}`,
  ]);
  await pool.query(
    `INSERT INTO item_revisions(
       id, content_release_id, item_id, display_name, item_kind, effect_key, effect_config, active
     ) VALUES ($1, $2, $3, 'Clone Item', 'HELD', NULL, '{}'::jsonb, TRUE)`,
    [randomUUID(), parentReleaseId, parentItemId],
  );
  await pool.query(`INSERT INTO reward_definitions(id, slug) VALUES ($1, $2)`, [
    parentRewardId,
    `phase12-clone-reward-${parentRewardId}`,
  ]);
  await pool.query(
    `INSERT INTO reward_revisions(
       id, content_release_id, reward_id, display_name, program, active
     ) VALUES ($1, $2, $3, 'Clone Reward', $4::jsonb, TRUE)`,
    [
      randomUUID(),
      parentReleaseId,
      parentRewardId,
      JSON.stringify({
        version: 1,
        grants: [{ kind: "ITEM", itemId: parentItemId, quantity: 1 }],
      }),
    ],
  );
  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [parentReleaseId, "a".repeat(64)],
  );
  await pool.query(
    `UPDATE content_releases SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [parentReleaseId],
  );

  const catalog = new CatalogService(catalogRepository);
  const cloned = await catalog.clonePublishedRelease({
    parentReleaseId,
    newReleaseId: childReleaseId,
    releaseNo: childReleaseNo,
    name: "Phase 12 Reward Clone Child",
  });
  if (!cloned.ok) throw new Error(`Catalog reward clone failed: ${cloned.error.code}`);
  const childSnapshot = await catalogRepository.read((transaction) =>
    transaction.loadCatalogSnapshot(childReleaseId),
  );
  if (
    childSnapshot?.rewards?.length !== 1 ||
    childSnapshot.rewards[0]?.rewardId !== parentRewardId ||
    childSnapshot.rewards[0]?.active !== true
  ) {
    throw new Error("Published release clone did not preserve versioned reward content");
  }
  const cloneDiff = await catalog.diffReleases(parentReleaseId, childReleaseId);
  if (!cloneDiff.ok) throw new Error(`Catalog clone diff failed: ${cloneDiff.error.code}`);
  const rewardDiff = cloneDiff.value.sections.find((section) => section.category === "rewards");
  if (
    rewardDiff === undefined ||
    rewardDiff.added !== 0 ||
    rewardDiff.removed !== 0 ||
    rewardDiff.changed !== 0
  ) {
    throw new Error("Cloned reward content is not fingerprint/diff equivalent to its parent");
  }

  await pool.query(
    `UPDATE content_releases
     SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid":true,"issues":[]}'::jsonb,
         content_fingerprint = $2
     WHERE id = $1`,
    [releaseId, "b".repeat(64)],
  );
  const nonDraftMutation = await draftOwner.create({
    releaseId,
    resource: {
      kind: "EFFECT",
      slug: `phase12-proof-nondraft-effect-${randomUUID()}`,
      scope: "POKEMON",
      stackingPolicy: "REPLACE",
      durationModel: "PERMANENT",
      rules: {
        version: 1,
        steps: [{ effectKey: "heal-hp", config: { amount: 4 } }],
      },
    },
    expectedRevision: releaseRevision,
    idempotencyKey: `catalog-nondraft-${randomUUID()}`,
    correlationId: randomUUID(),
    metadata: {
      sourceType: "SYSTEM",
      sourceId: randomUUID(),
      reason: "Reject non-DRAFT mutation",
      actorType: "SYSTEM",
      actorId: null,
    },
  });
  expectOwnerCode(nonDraftMutation, "INVALID_STATE_TRANSITION", "Non-DRAFT catalog mutation");

  const encounterEntry = await pool.query<{ id: string }>(
    `SELECT entry.id
     FROM encounter_entries entry
     JOIN encounter_table_revisions revision
       ON revision.id = entry.encounter_table_revision_id
     WHERE revision.content_release_id = $1 AND revision.encounter_table_id = $2
     LIMIT 1`,
    [releaseId, encounterTableId],
  );
  const encounterEntryId = encounterEntry.rows[0]?.id;
  if (encounterEntryId === undefined) throw new Error("Encounter entry immutability fixture missing");
  await expectSqlState(
    pool.query(`DELETE FROM encounter_entries WHERE id = $1`, [encounterEntryId]),
    "55000",
    "Encounter entry DELETE outside DRAFT",
  );

  console.log("phase12 catalog draft admin proof passed");
} finally {
  await pool.end();
}
