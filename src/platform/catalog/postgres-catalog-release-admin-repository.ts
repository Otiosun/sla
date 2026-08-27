import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ContentLifecycleStatusSchema,
  type ValidationReport,
} from "../../modules/catalog/contracts.js";
import type {
  CatalogReleaseAdminClaim,
  CatalogReleaseAdminClaimInsert,
  CatalogReleaseLifecycleMutationResult,
  CatalogReleaseLifecycleOperation,
  CatalogReleaseLifecycleState,
} from "../../modules/catalog/release-admin-contracts.js";
import type {
  CatalogReleaseAdminRecord,
  CatalogReleaseAdminRepository,
  CatalogReleaseAdminTransaction,
} from "../../modules/catalog/release-admin-service.js";
import type { CatalogSnapshotWithEffects } from "../../modules/catalog/validation.js";
import { withTransaction } from "../db/transaction.js";
import { PostgresCatalogRepository } from "./postgres-catalog-repository.js";

interface ReleaseRow {
  readonly id: string;
  readonly status: string;
  readonly revision: string;
  readonly parent_release_id: string | null;
  readonly default_ruleset_id: string;
  readonly content_fingerprint: string | null;
}

interface ClaimRow {
  readonly operation_kind: string;
  readonly content_release_id: string;
  readonly request_fingerprint: string;
  readonly expected_revision: string;
  readonly before_status: string;
  readonly after_status: string;
  readonly before_data: unknown;
  readonly after_data: unknown;
  readonly result: unknown;
}

function expectOneRow(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) throw new Error(`${operation} did not affect exactly one row`);
}

function jsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseState(value: unknown, label: string): CatalogReleaseLifecycleState {
  const record = jsonRecord(value, label);
  const status = ContentLifecycleStatusSchema.parse(record.status);
  if (
    typeof record.releaseId !== "string" ||
    typeof record.revision !== "string" ||
    (record.parentReleaseId !== null && typeof record.parentReleaseId !== "string") ||
    typeof record.defaultRulesetId !== "string" ||
    (record.contentFingerprint !== null && typeof record.contentFingerprint !== "string")
  ) {
    throw new Error(`${label} contains invalid release lifecycle evidence`);
  }
  return {
    releaseId: record.releaseId,
    status,
    revision: record.revision,
    parentReleaseId: record.parentReleaseId as string | null,
    defaultRulesetId: record.defaultRulesetId,
    contentFingerprint: record.contentFingerprint as string | null,
  };
}

function parseResult(value: unknown): CatalogReleaseLifecycleMutationResult {
  const record = jsonRecord(value, "Catalog release admin claim result");
  if (
    (record.operationKind !== "VALIDATE" && record.operationKind !== "PUBLISH") ||
    typeof record.releaseId !== "string" ||
    typeof record.revision !== "string" ||
    (record.beforeStatus !== "DRAFT" && record.beforeStatus !== "VALIDATED") ||
    (record.afterStatus !== "VALIDATED" && record.afterStatus !== "PUBLISHED") ||
    typeof record.fingerprint !== "string"
  ) {
    throw new Error("Catalog release admin claim result is invalid");
  }
  return {
    operationKind: record.operationKind,
    releaseId: record.releaseId,
    revision: record.revision,
    beforeStatus: record.beforeStatus,
    afterStatus: record.afterStatus,
    fingerprint: record.fingerprint,
    beforeData: parseState(record.beforeData, "Catalog release claim beforeData"),
    afterData: parseState(record.afterData, "Catalog release claim afterData"),
    replayed: true,
  };
}

function parseOperationKind(value: string): CatalogReleaseLifecycleOperation {
  if (value !== "VALIDATE" && value !== "PUBLISH") {
    throw new Error("Catalog release admin claim has invalid operation kind");
  }
  return value;
}

function parseTransitionStatus(value: string, side: "before" | "after") {
  if (side === "before" && value !== "DRAFT" && value !== "VALIDATED") {
    throw new Error("Catalog release admin claim has invalid before status");
  }
  if (side === "after" && value !== "VALIDATED" && value !== "PUBLISHED") {
    throw new Error("Catalog release admin claim has invalid after status");
  }
  return value as "DRAFT" | "VALIDATED" | "PUBLISHED";
}

function releaseRecord(row: ReleaseRow): CatalogReleaseAdminRecord {
  const revision = BigInt(row.revision);
  if (revision < 0n) throw new Error("Content release revision cannot be negative");
  return {
    id: row.id,
    status: ContentLifecycleStatusSchema.parse(row.status),
    revision,
    parentReleaseId: row.parent_release_id,
    defaultRulesetId: row.default_ruleset_id,
    contentFingerprint: row.content_fingerprint,
  };
}

async function loadRelease(
  client: PoolClient,
  releaseId: string,
  lock = false,
): Promise<CatalogReleaseAdminRecord | null> {
  const result = await client.query<ReleaseRow>(
    `SELECT id, status, revision::text, parent_release_id, default_ruleset_id, content_fingerprint
     FROM content_releases
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [releaseId],
  );
  const row = result.rows[0];
  return row === undefined ? null : releaseRecord(row);
}

class PostgresCatalogReleaseAdminTransaction implements CatalogReleaseAdminTransaction {
  public constructor(
    private readonly client: PoolClient,
    private readonly snapshotReader: PostgresCatalogRepository,
  ) {}

  public async loadClaim(idempotencyKey: string): Promise<CatalogReleaseAdminClaim | null> {
    const result = await this.client.query<ClaimRow>(
      `SELECT operation_kind, content_release_id, request_fingerprint, expected_revision::text,
              before_status, after_status, before_data, after_data, result
       FROM catalog_release_admin_operation_claims
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      operationKind: parseOperationKind(row.operation_kind),
      releaseId: row.content_release_id,
      requestFingerprint: row.request_fingerprint,
      expectedRevision: BigInt(row.expected_revision),
      beforeStatus: parseTransitionStatus(row.before_status, "before") as "DRAFT" | "VALIDATED",
      afterStatus: parseTransitionStatus(row.after_status, "after") as "VALIDATED" | "PUBLISHED",
      beforeData: parseState(row.before_data, "Catalog release claim beforeData"),
      afterData: parseState(row.after_data, "Catalog release claim afterData"),
      result: parseResult(row.result),
    };
  }

  public loadRelease(releaseId: string, lock = false): Promise<CatalogReleaseAdminRecord | null> {
    return loadRelease(this.client, releaseId, lock);
  }

  public loadSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null> {
    // The outer transaction owns the catalog-release advisory lock shared with DRAFT CRUD.
    // This nested read therefore sees a stable owner-visible snapshot while keeping the existing
    // canonical snapshot loader as the single source of release projection logic.
    return this.snapshotReader.read((transaction) => transaction.loadCatalogSnapshot(releaseId));
  }

  public async setValidated(
    releaseId: string,
    report: ValidationReport,
    fingerprint: string,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE content_releases
       SET status = 'VALIDATED', validated_at = now(), validation_report = $2::jsonb,
           content_fingerprint = $3
       WHERE id = $1 AND status = 'DRAFT'`,
      [releaseId, JSON.stringify(report), fingerprint],
    );
    expectOneRow(result.rowCount, "admin content release validation transition");
  }

  public async setPublished(releaseId: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE content_releases
       SET status = 'PUBLISHED', published_at = now()
       WHERE id = $1 AND status = 'VALIDATED'`,
      [releaseId],
    );
    expectOneRow(result.rowCount, "admin content release publish transition");
  }

  public async insertClaim(claim: CatalogReleaseAdminClaimInsert): Promise<void> {
    await this.client.query(
      `INSERT INTO catalog_release_admin_operation_claims(
         id, operation_kind, content_release_id, idempotency_key, request_fingerprint,
         expected_revision, before_status, after_status, before_data, after_data, result,
         correlation_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
         $12
       )`,
      [
        randomUUID(),
        claim.operationKind,
        claim.releaseId,
        claim.idempotencyKey,
        claim.requestFingerprint,
        claim.expectedRevision.toString(),
        claim.beforeStatus,
        claim.afterStatus,
        JSON.stringify(claim.beforeData),
        JSON.stringify(claim.afterData),
        JSON.stringify(claim.result),
        claim.correlationId,
      ],
    );
  }
}

export class PostgresCatalogReleaseAdminRepository implements CatalogReleaseAdminRepository {
  private readonly snapshotReader: PostgresCatalogRepository;

  public constructor(private readonly pool: Pool) {
    this.snapshotReader = new PostgresCatalogRepository(pool);
  }

  public async transaction<T>(
    releaseId: string,
    idempotencyKey: string,
    work: (transaction: CatalogReleaseAdminTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(
      this.pool,
      async (client) => {
        for (const key of [
          `catalog-release:${releaseId}`,
          `catalog-release-admin:${idempotencyKey}`,
        ].sort()) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
        }
        return work(new PostgresCatalogReleaseAdminTransaction(client, this.snapshotReader));
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }

  public async readRelease(releaseId: string): Promise<CatalogReleaseAdminRecord | null> {
    return withTransaction(this.pool, (client) => loadRelease(client, releaseId), {
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
    });
  }

  public loadSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null> {
    return this.snapshotReader.read((transaction) => transaction.loadCatalogSnapshot(releaseId));
  }
}
