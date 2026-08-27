import { createHash } from "node:crypto";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type {
  CatalogDraftCreateInput,
  CatalogDraftDeactivateInput,
  CatalogDraftInspectInput,
  CatalogDraftMutationMetadata,
  CatalogDraftMutationResult,
  CatalogDraftReplaceInput,
  CatalogDraftResourceView,
} from "./draft-contracts.js";

export interface CatalogDraftOwnerMutationContext {
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly metadata: CatalogDraftMutationMetadata;
}

export type CatalogDraftPersistenceResult =
  | { readonly kind: "PERSISTED"; readonly result: CatalogDraftMutationResult }
  | { readonly kind: "REPLAYED"; readonly result: CatalogDraftMutationResult }
  | { readonly kind: "IDEMPOTENCY_CONFLICT" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "NOT_DRAFT"; readonly status: string }
  | { readonly kind: "REVISION_CONFLICT"; readonly actualRevision: bigint }
  | { readonly kind: "RESOURCE_CONFLICT"; readonly reason: string }
  | { readonly kind: "INVALID_RESOURCE"; readonly reason: string };

export interface CatalogDraftRepository {
  inspect(input: CatalogDraftInspectInput): Promise<CatalogDraftResourceView | null>;
  create(
    input: CatalogDraftCreateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult>;
  replace(
    input: CatalogDraftReplaceInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult>;
  deactivate(
    input: CatalogDraftDeactivateInput &
      CatalogDraftOwnerMutationContext & { readonly requestFingerprint: string },
  ): Promise<CatalogDraftPersistenceResult>;
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function persistenceResult(
  result: CatalogDraftPersistenceResult,
): Result<CatalogDraftMutationResult> {
  if (result.kind === "PERSISTED" || result.kind === "REPLAYED") return ok(result.result);
  if (result.kind === "IDEMPOTENCY_CONFLICT") {
    return err(
      appError("FINGERPRINT_MISMATCH", "Catalog draft replay evidence conflicts with request"),
    );
  }
  if (result.kind === "NOT_FOUND") {
    return err(appError("NOT_FOUND", "Catalog draft target was not found"));
  }
  if (result.kind === "NOT_DRAFT") {
    return err(
      appError(
        "INVALID_STATE_TRANSITION",
        "Catalog content may be edited only in a DRAFT release",
        {
          status: result.status,
        },
      ),
    );
  }
  if (result.kind === "REVISION_CONFLICT") {
    return err(
      appError("REVISION_CONFLICT", "Content release revision changed", {
        actualRevision: result.actualRevision.toString(),
      }),
    );
  }
  return err(
    appError(
      result.kind === "RESOURCE_CONFLICT" ? "ACTION_INVALID" : "VALIDATION_FAILED",
      result.reason,
    ),
  );
}

export class CatalogDraftService {
  public constructor(private readonly repository: CatalogDraftRepository) {}

  public async inspect(input: CatalogDraftInspectInput): Promise<Result<CatalogDraftResourceView>> {
    const value = await this.repository.inspect(input);
    return value === null
      ? err(appError("NOT_FOUND", "Catalog draft resource was not found"))
      : ok(value);
  }

  public async create(
    input: CatalogDraftCreateInput & CatalogDraftOwnerMutationContext,
  ): Promise<Result<CatalogDraftMutationResult>> {
    const requestFingerprint = fingerprint({
      operationKind: "CREATE",
      releaseId: input.releaseId,
      resource: input.resource,
      expectedRevision: input.expectedRevision,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return persistenceResult(await this.repository.create({ ...input, requestFingerprint }));
  }

  public async replace(
    input: CatalogDraftReplaceInput & CatalogDraftOwnerMutationContext,
  ): Promise<Result<CatalogDraftMutationResult>> {
    const requestFingerprint = fingerprint({
      operationKind: "REPLACE",
      releaseId: input.releaseId,
      resourceId: input.resourceId,
      resource: input.resource,
      expectedRevision: input.expectedRevision,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return persistenceResult(await this.repository.replace({ ...input, requestFingerprint }));
  }

  public async deactivate(
    input: CatalogDraftDeactivateInput & CatalogDraftOwnerMutationContext,
  ): Promise<Result<CatalogDraftMutationResult>> {
    const requestFingerprint = fingerprint({
      operationKind: "DEACTIVATE",
      releaseId: input.releaseId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      expectedRevision: input.expectedRevision,
      correlationId: input.correlationId,
      metadata: input.metadata,
    });
    return persistenceResult(await this.repository.deactivate({ ...input, requestFingerprint }));
  }
}
