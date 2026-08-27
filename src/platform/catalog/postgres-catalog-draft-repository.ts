import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftInspectInput,
  CatalogDraftMutationResult,
  CatalogDraftReplaceInput,
  CatalogDraftResourceKind,
  CatalogDraftResourceView,
} from "../../modules/catalog/draft-contracts.js";
import type {
  CatalogDraftOwnerMutationContext,
  CatalogDraftPersistenceResult,
  CatalogDraftRepository,
} from "../../modules/catalog/draft-service.js";
import { withTransaction } from "../db/transaction.js";
import {
  CatalogReferenceError,
  createCatalogDraftResource,
  deactivateCatalogDraftResource,
  inspectCatalogDraftResource,
  jsonRecord,
  loadCatalogReleaseAdminRow,
  replaceCatalogDraftResource,
} from "./catalog-draft-sql.js";

interface ClaimRow {
  readonly operation_kind: string;
  readonly content_release_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly request_fingerprint: string;
  readonly result: unknown;
}

type MutationEnvelope = CatalogDraftOwnerMutationContext & {
  readonly releaseId: string;
  readonly requestFingerprint: string;
};

function safeRevision(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error("Catalog release revision cannot be negative");
  return parsed;
}

function replayResult(value: unknown): CatalogDraftMutationResult {
  const record = jsonRecord(value);
  if (
    (record.operationKind !== "CREATE" &&
      record.operationKind !== "REPLACE" &&
      record.operationKind !== "DEACTIVATE") ||
    typeof record.resourceKind !== "string" ||
    typeof record.resourceId !== "string" ||
    typeof record.beforeRevision !== "string" ||
    typeof record.afterRevision !== "string" ||
    record.afterData === null ||
    typeof record.afterData !== "object"
  ) {
    throw new Error("Catalog admin claim contains invalid replay evidence");
  }
  return {
    operationKind: record.operationKind,
    resourceKind: record.resourceKind as CatalogDraftResourceKind,
    resourceId: record.resourceId,
    beforeRevision: record.beforeRevision,
    afterRevision: record.afterRevision,
    beforeData:
      record.beforeData === null || record.beforeData === undefined
        ? null
        : jsonRecord(record.beforeData),
    afterData: jsonRecord(record.afterData),
    replayed: true,
  };
}

async function acquireLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

async function replayClaim(
  client: PoolClient,
  input: {
    readonly releaseId: string;
    readonly operationKind: "CREATE" | "REPLACE" | "DEACTIVATE";
    readonly resourceKind: CatalogDraftResourceKind;
    readonly resourceId: string | null;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
  },
): Promise<CatalogDraftPersistenceResult | null> {
  const result = await client.query<ClaimRow>(
    `SELECT operation_kind, content_release_id, resource_kind, resource_id,
            request_fingerprint, result
     FROM catalog_admin_operation_claims
     WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (
    row.operation_kind !== input.operationKind ||
    row.content_release_id !== input.releaseId ||
    row.resource_kind !== input.resourceKind ||
    (input.resourceId !== null && row.resource_id !== input.resourceId) ||
    row.request_fingerprint !== input.requestFingerprint
  ) {
    return { kind: "IDEMPOTENCY_CONFLICT" };
  }
  return { kind: "REPLAYED", result: replayResult(row.result) };
}

function pgCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

class ResourceMissingError extends Error {}

export class PostgresCatalogDraftRepository implements CatalogDraftRepository {
  public constructor(private readonly pool: Pool) {}

  public async inspect(input: CatalogDraftInspectInput): Promise<CatalogDraftResourceView | null> {
    return withTransaction(this.pool, (client) => inspectCatalogDraftResource(client, input), {
      isolationLevel: "REPEATABLE READ",
      readOnly: true,
    });
  }

  public async create(
    input: CatalogDraftCreateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    const resourceId = randomUUID();
    try {
      return await this.mutate(
        input,
        "CREATE",
        input.resource.kind,
        resourceId,
        (client) => createCatalogDraftResource(client, input, resourceId),
      );
    } catch (error) {
      return this.mapPersistenceError(error, "Catalog resource could not be created");
    }
  }

  public async replace(
    input: CatalogDraftReplaceInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    try {
      return await this.mutate(
        input,
        "REPLACE",
        input.resource.kind,
        input.resourceId,
        async (client) => {
          if (!(await replaceCatalogDraftResource(client, input))) throw new ResourceMissingError();
        },
      );
    } catch (error) {
      return this.mapPersistenceError(error, "Catalog resource could not be replaced");
    }
  }

  public async deactivate(
    input: CatalogDraftDeactivateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult> {
    try {
      return await this.mutate(
        input,
        "DEACTIVATE",
        input.resourceKind,
        input.resourceId,
        async (client) => {
          if (!(await deactivateCatalogDraftResource(client, input))) throw new ResourceMissingError();
        },
      );
    } catch (error) {
      return this.mapPersistenceError(error, "Catalog resource could not be deactivated");
    }
  }

  private mapPersistenceError(error: unknown, fallback: string): CatalogDraftPersistenceResult {
    if (error instanceof ResourceMissingError) return { kind: "NOT_FOUND" };
    if (error instanceof CatalogReferenceError) {
      return { kind: "INVALID_RESOURCE", reason: error.message };
    }
    const code = pgCode(error);
    if (code === "23505") {
      return { kind: "RESOURCE_CONFLICT", reason: "Catalog identity already exists" };
    }
    if (code === "23503" || code === "23514") {
      return {
        kind: "INVALID_RESOURCE",
        reason: "Catalog resource violates a persisted reference or constraint",
      };
    }
    throw error instanceof Error ? error : new Error(fallback);
  }

  private async mutate(
    input: MutationEnvelope,
    operationKind: "CREATE" | "REPLACE" | "DEACTIVATE",
    resourceKind: CatalogDraftResourceKind,
    resourceId: string,
    mutation: (client: PoolClient) => Promise<void>,
  ): Promise<CatalogDraftPersistenceResult> {
    return withTransaction(this.pool, async (client) => {
      await acquireLocks(client, [
        `catalog-release:${input.releaseId}`,
        `catalog-admin:${input.idempotencyKey}`,
      ]);
      const replay = await replayClaim(client, {
        releaseId: input.releaseId,
        operationKind,
        resourceKind,
        resourceId: operationKind === "CREATE" ? null : resourceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      });
      if (replay !== null) return replay;

      const release = await loadCatalogReleaseAdminRow(client, input.releaseId, true);
      if (release === null) return { kind: "NOT_FOUND" };
      if (release.status !== "DRAFT") return { kind: "NOT_DRAFT", status: release.status };
      const beforeRevision = safeRevision(release.revision);
      if (beforeRevision !== input.expectedRevision) {
        return { kind: "REVISION_CONFLICT", actualRevision: beforeRevision };
      }

      const before =
        operationKind === "CREATE"
          ? null
          : await inspectCatalogDraftResource(client, {
              releaseId: input.releaseId,
              resourceKind,
              resourceId,
            });
      if (operationKind !== "CREATE" && before === null) return { kind: "NOT_FOUND" };

      await mutation(client);
      const advanced = await client.query<{ revision: string }>(
        `UPDATE content_releases
         SET revision = revision + 1
         WHERE id = $1 AND status = 'DRAFT' AND revision = $2
         RETURNING revision::text`,
        [input.releaseId, beforeRevision.toString()],
      );
      const afterRevisionText = advanced.rows[0]?.revision;
      if (afterRevisionText === undefined) {
        const fresh = await loadCatalogReleaseAdminRow(client, input.releaseId);
        return {
          kind: "REVISION_CONFLICT",
          actualRevision: fresh === null ? beforeRevision : safeRevision(fresh.revision),
        };
      }
      const afterRevision = safeRevision(afterRevisionText);
      const after = await inspectCatalogDraftResource(client, {
        releaseId: input.releaseId,
        resourceKind,
        resourceId,
      });
      if (after === null) throw new Error("Catalog draft resource disappeared after mutation");

      const result: CatalogDraftMutationResult = {
        operationKind,
        resourceKind,
        resourceId,
        beforeRevision: beforeRevision.toString(),
        afterRevision: afterRevision.toString(),
        beforeData: before,
        afterData: after,
        replayed: false,
      };
      await client.query(
        `INSERT INTO catalog_admin_operation_claims(
           id, operation_kind, content_release_id, resource_kind, resource_id,
           idempotency_key, request_fingerprint, before_revision, after_revision,
           before_data, after_data, result, correlation_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10::jsonb, $11::jsonb, $12::jsonb, $13
         )`,
        [
          randomUUID(),
          operationKind,
          input.releaseId,
          resourceKind,
          resourceId,
          input.idempotencyKey,
          input.requestFingerprint,
          beforeRevision.toString(),
          afterRevision.toString(),
          before === null ? null : JSON.stringify(before),
          JSON.stringify(after),
          JSON.stringify(result),
          input.correlationId,
        ],
      );
      return { kind: "PERSISTED", result };
    });
  }
}
