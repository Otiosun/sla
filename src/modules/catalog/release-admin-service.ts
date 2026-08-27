import { createHash } from "node:crypto";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { ValidationReport } from "./contracts.js";
import { diffCatalogSnapshots, type ReleaseDiff } from "./diff.js";
import { validateCatalogDraftExtensions } from "./draft-extension-validation.js";
import { fingerprintCatalog } from "./fingerprint.js";
import type {
  CatalogReleaseAdminClaim,
  CatalogReleaseAdminClaimInsert,
  CatalogReleaseLifecycleMutationResult,
  CatalogReleaseLifecycleOperation,
  CatalogReleaseLifecycleState,
  CatalogReleaseOwnerMutationContext,
  CatalogReleasePublishPreview,
} from "./release-admin-contracts.js";
import { validateCatalogSnapshot, type CatalogSnapshotWithEffects } from "./validation.js";

export interface CatalogReleaseAdminRecord {
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly revision: bigint;
  readonly parentReleaseId: string | null;
  readonly defaultRulesetId: string;
  readonly contentFingerprint: string | null;
}

export interface CatalogReleaseAdminTransaction {
  loadClaim(idempotencyKey: string): Promise<CatalogReleaseAdminClaim | null>;
  loadRelease(releaseId: string, lock?: boolean): Promise<CatalogReleaseAdminRecord | null>;
  loadSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null>;
  setValidated(releaseId: string, report: ValidationReport, fingerprint: string): Promise<void>;
  setPublished(releaseId: string): Promise<void>;
  insertClaim(claim: CatalogReleaseAdminClaimInsert): Promise<void>;
}

export interface CatalogReleaseAdminRepository {
  transaction<T>(
    releaseId: string,
    idempotencyKey: string,
    work: (transaction: CatalogReleaseAdminTransaction) => Promise<T>,
  ): Promise<T>;
  readRelease(releaseId: string): Promise<CatalogReleaseAdminRecord | null>;
  loadSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null>;
}

function validateReleaseSnapshot(snapshot: CatalogSnapshotWithEffects): ValidationReport {
  const base = validateCatalogSnapshot(snapshot);
  const extensions = validateCatalogDraftExtensions(snapshot);
  const issues = [...base.issues, ...extensions.issues];
  return { valid: issues.length === 0, issues };
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

function requestFingerprint(input: {
  readonly operationKind: CatalogReleaseLifecycleOperation;
  readonly releaseId: string;
  readonly context: CatalogReleaseOwnerMutationContext;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        normalize({
          operationKind: input.operationKind,
          releaseId: input.releaseId,
          expectedRevision: input.context.expectedRevision,
          correlationId: input.context.correlationId,
          metadata: input.context.metadata,
        }),
      ),
    )
    .digest("hex");
}

function releaseState(release: CatalogReleaseAdminRecord): CatalogReleaseLifecycleState {
  return {
    releaseId: release.id,
    status: release.status,
    revision: release.revision.toString(),
    parentReleaseId: release.parentReleaseId,
    defaultRulesetId: release.defaultRulesetId,
    contentFingerprint: release.contentFingerprint,
  };
}

function replay(
  claim: CatalogReleaseAdminClaim,
  fingerprint: string,
  operationKind: CatalogReleaseLifecycleOperation,
  releaseId: string,
  expectedRevision: bigint,
): Result<CatalogReleaseLifecycleMutationResult> {
  if (
    claim.requestFingerprint !== fingerprint ||
    claim.operationKind !== operationKind ||
    claim.releaseId !== releaseId ||
    claim.expectedRevision !== expectedRevision
  ) {
    return err(
      appError("IDEMPOTENCY_KEY_INVALID", "Catalog release lifecycle replay conflicts with request"),
    );
  }
  return ok({ ...claim.result, replayed: true });
}

function revisionConflict(expected: bigint, actual: bigint) {
  return appError("REVISION_CONFLICT", "Content release revision changed", {
    expectedRevision: expected.toString(),
    actualRevision: actual.toString(),
  });
}

function invalidState(resource: string, status: string, expected: string) {
  return appError(
    "INVALID_STATE_TRANSITION",
    `${resource} is not in the required lifecycle state`,
    { status, expected },
  );
}

function notFound(resource: string, id: string) {
  return appError("NOT_FOUND", `${resource} was not found`, { id });
}

export class CatalogReleaseAdminService {
  public constructor(private readonly repository: CatalogReleaseAdminRepository) {}

  public async diffReleases(fromReleaseId: string, toReleaseId: string): Promise<Result<ReleaseDiff>> {
    const [from, to] = await Promise.all([
      this.repository.loadSnapshot(fromReleaseId),
      this.repository.loadSnapshot(toReleaseId),
    ]);
    if (from === null) return err(notFound("Content release", fromReleaseId));
    if (to === null) return err(notFound("Content release", toReleaseId));
    return ok(diffCatalogSnapshots(from, to));
  }

  public async previewPublishRelease(releaseId: string): Promise<Result<CatalogReleasePublishPreview>> {
    const release = await this.repository.readRelease(releaseId);
    if (release === null) return err(notFound("Content release", releaseId));
    if (release.status !== "VALIDATED") {
      return err(invalidState("Content release", release.status, "VALIDATED"));
    }
    const snapshot = await this.repository.loadSnapshot(releaseId);
    if (snapshot === null) return err(notFound("Content release snapshot", releaseId));
    if (snapshot.ruleset.status !== "PUBLISHED") {
      return err(invalidState("Default ruleset", snapshot.ruleset.status, "PUBLISHED"));
    }
    const fingerprint = fingerprintCatalog(snapshot);
    if (release.contentFingerprint === null || release.contentFingerprint !== fingerprint) {
      return err(
        appError("FINGERPRINT_MISMATCH", "Content release changed after validation", {
          expected: release.contentFingerprint,
          actual: fingerprint,
        }),
      );
    }
    const parent =
      release.parentReleaseId === null
        ? null
        : await this.repository.loadSnapshot(release.parentReleaseId);
    if (release.parentReleaseId !== null && parent === null) {
      return err(notFound("Parent content release", release.parentReleaseId));
    }
    const before = releaseState(release);
    return ok({
      releaseId,
      revision: release.revision.toString(),
      parentReleaseId: release.parentReleaseId,
      fingerprint,
      before,
      after: { ...before, status: "PUBLISHED" },
      diff: parent === null ? null : diffCatalogSnapshots(parent, snapshot),
    });
  }

  public async validate(
    input: { readonly releaseId: string } & CatalogReleaseOwnerMutationContext,
  ): Promise<Result<CatalogReleaseLifecycleMutationResult>> {
    const fingerprint = requestFingerprint({
      operationKind: "VALIDATE",
      releaseId: input.releaseId,
      context: input,
    });
    return this.repository.transaction(input.releaseId, input.idempotencyKey, async (transaction) => {
      const existing = await transaction.loadClaim(input.idempotencyKey);
      if (existing !== null) {
        return replay(existing, fingerprint, "VALIDATE", input.releaseId, input.expectedRevision);
      }
      const release = await transaction.loadRelease(input.releaseId, true);
      if (release === null) return err(notFound("Content release", input.releaseId));
      if (release.revision !== input.expectedRevision) {
        return err(revisionConflict(input.expectedRevision, release.revision));
      }
      if (release.status !== "DRAFT") {
        return err(invalidState("Content release", release.status, "DRAFT"));
      }
      const snapshot = await transaction.loadSnapshot(input.releaseId);
      if (snapshot === null) return err(notFound("Content release snapshot", input.releaseId));
      const validation = validateReleaseSnapshot(snapshot);
      if (!validation.valid) {
        return err(
          appError("VALIDATION_FAILED", "Content release validation failed", {
            issues: validation.issues,
          }),
        );
      }
      const contentFingerprint = fingerprintCatalog(snapshot);
      const beforeData = releaseState(release);
      await transaction.setValidated(input.releaseId, validation, contentFingerprint);
      const afterData: CatalogReleaseLifecycleState = {
        ...beforeData,
        status: "VALIDATED",
        contentFingerprint,
      };
      const result: CatalogReleaseLifecycleMutationResult = {
        operationKind: "VALIDATE",
        releaseId: input.releaseId,
        revision: release.revision.toString(),
        beforeStatus: "DRAFT",
        afterStatus: "VALIDATED",
        fingerprint: contentFingerprint,
        beforeData,
        afterData,
        replayed: false,
      };
      await transaction.insertClaim({
        operationKind: "VALIDATE",
        releaseId: input.releaseId,
        requestFingerprint: fingerprint,
        expectedRevision: input.expectedRevision,
        beforeStatus: "DRAFT",
        afterStatus: "VALIDATED",
        beforeData,
        afterData,
        result,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
      return ok(result);
    });
  }

  public async publish(
    input: { readonly releaseId: string } & CatalogReleaseOwnerMutationContext,
  ): Promise<Result<CatalogReleaseLifecycleMutationResult>> {
    const fingerprint = requestFingerprint({
      operationKind: "PUBLISH",
      releaseId: input.releaseId,
      context: input,
    });
    return this.repository.transaction(input.releaseId, input.idempotencyKey, async (transaction) => {
      const existing = await transaction.loadClaim(input.idempotencyKey);
      if (existing !== null) {
        return replay(existing, fingerprint, "PUBLISH", input.releaseId, input.expectedRevision);
      }
      const release = await transaction.loadRelease(input.releaseId, true);
      if (release === null) return err(notFound("Content release", input.releaseId));
      if (release.revision !== input.expectedRevision) {
        return err(revisionConflict(input.expectedRevision, release.revision));
      }
      if (release.status !== "VALIDATED") {
        return err(invalidState("Content release", release.status, "VALIDATED"));
      }
      const snapshot = await transaction.loadSnapshot(input.releaseId);
      if (snapshot === null) return err(notFound("Content release snapshot", input.releaseId));
      if (snapshot.ruleset.status !== "PUBLISHED") {
        return err(invalidState("Default ruleset", snapshot.ruleset.status, "PUBLISHED"));
      }
      const contentFingerprint = fingerprintCatalog(snapshot);
      if (
        release.contentFingerprint === null ||
        release.contentFingerprint !== contentFingerprint
      ) {
        return err(
          appError("FINGERPRINT_MISMATCH", "Content release changed after validation", {
            expected: release.contentFingerprint,
            actual: contentFingerprint,
          }),
        );
      }
      const beforeData = releaseState(release);
      await transaction.setPublished(input.releaseId);
      const afterData: CatalogReleaseLifecycleState = { ...beforeData, status: "PUBLISHED" };
      const result: CatalogReleaseLifecycleMutationResult = {
        operationKind: "PUBLISH",
        releaseId: input.releaseId,
        revision: release.revision.toString(),
        beforeStatus: "VALIDATED",
        afterStatus: "PUBLISHED",
        fingerprint: contentFingerprint,
        beforeData,
        afterData,
        replayed: false,
      };
      await transaction.insertClaim({
        operationKind: "PUBLISH",
        releaseId: input.releaseId,
        requestFingerprint: fingerprint,
        expectedRevision: input.expectedRevision,
        beforeStatus: "VALIDATED",
        afterStatus: "PUBLISHED",
        beforeData,
        afterData,
        result,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
      return ok(result);
    });
  }
}
