import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CatalogSnapshot, RulesetSnapshot, ValidationReport } from "./contracts.js";
import { diffCatalogSnapshots, type ReleaseDiff } from "./diff.js";
import { validateCatalogDraftExtensions } from "./draft-extension-validation.js";
import { fingerprintCatalog, fingerprintRuleset } from "./fingerprint.js";
import {
  validateCatalogSnapshot,
  validateRulesetSnapshot,
  type CatalogSnapshotWithEffects,
} from "./validation.js";

export interface RulesetRecord extends RulesetSnapshot {
  readonly configFingerprint: string | null;
}

export interface CatalogReleaseRecord {
  readonly id: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly contentFingerprint: string | null;
  readonly parentReleaseId: string | null;
}

export interface CatalogTransaction {
  loadRuleset(rulesetId: string, lock?: boolean): Promise<RulesetRecord | null>;
  setRulesetValidated(
    rulesetId: string,
    report: ValidationReport,
    fingerprint: string,
  ): Promise<void>;
  setRulesetPublished(rulesetId: string): Promise<void>;

  loadReleaseRecord(releaseId: string, lock?: boolean): Promise<CatalogReleaseRecord | null>;
  loadCatalogSnapshot(releaseId: string): Promise<CatalogSnapshotWithEffects | null>;
  setReleaseValidated(
    releaseId: string,
    report: ValidationReport,
    fingerprint: string,
  ): Promise<void>;
  setReleasePublished(releaseId: string): Promise<void>;
  setReleaseArchived(releaseId: string): Promise<void>;
  activateRelease(releaseId: string): Promise<void>;
  activeReleaseId(): Promise<string | null>;
  cloneRelease(input: {
    readonly parentReleaseId: string;
    readonly newReleaseId: string;
    readonly releaseNo: bigint;
    readonly name: string;
  }): Promise<void>;
}

export interface CatalogRepository {
  transaction<T>(work: (transaction: CatalogTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: CatalogTransaction) => Promise<T>): Promise<T>;
}

export interface ValidationSuccess {
  readonly fingerprint: string;
  readonly report: ValidationReport;
}

function notFound(resource: string, id: string) {
  return appError("NOT_FOUND", `${resource} was not found`, { id });
}

function invalidState(resource: string, status: string, expected: string) {
  return appError(
    "INVALID_STATE_TRANSITION",
    `${resource} is not in the required lifecycle state`,
    {
      status,
      expected,
    },
  );
}

function validateReleaseSnapshot(snapshot: CatalogSnapshotWithEffects): ValidationReport {
  const base = validateCatalogSnapshot(snapshot);
  const extensions = validateCatalogDraftExtensions(snapshot);
  const issues = [...base.issues, ...extensions.issues];
  return { valid: issues.length === 0, issues };
}

export class CatalogService {
  public constructor(private readonly repository: CatalogRepository) {}

  public async validateRuleset(rulesetId: string): Promise<Result<ValidationSuccess>> {
    return this.repository.transaction(async (transaction) => {
      const ruleset = await transaction.loadRuleset(rulesetId, true);
      if (ruleset === null) return err(notFound("Ruleset", rulesetId));
      if (ruleset.status !== "DRAFT") return err(invalidState("Ruleset", ruleset.status, "DRAFT"));

      const validation = validateRulesetSnapshot(ruleset);
      if (!validation.valid) {
        return err(
          appError("VALIDATION_FAILED", "Ruleset validation failed", {
            issues: validation.issues,
          }),
        );
      }

      const fingerprint = fingerprintRuleset(ruleset);
      await transaction.setRulesetValidated(rulesetId, validation, fingerprint);
      return ok({ fingerprint, report: validation });
    });
  }

  public async publishRuleset(rulesetId: string): Promise<Result<{ readonly rulesetId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const ruleset = await transaction.loadRuleset(rulesetId, true);
      if (ruleset === null) return err(notFound("Ruleset", rulesetId));
      if (ruleset.status !== "VALIDATED") {
        return err(invalidState("Ruleset", ruleset.status, "VALIDATED"));
      }

      const fingerprint = fingerprintRuleset(ruleset);
      if (ruleset.configFingerprint === null || ruleset.configFingerprint !== fingerprint) {
        return err(
          appError("FINGERPRINT_MISMATCH", "Ruleset changed after validation", {
            expected: ruleset.configFingerprint,
            actual: fingerprint,
          }),
        );
      }

      await transaction.setRulesetPublished(rulesetId);
      return ok({ rulesetId });
    });
  }

  public async validateRelease(releaseId: string): Promise<Result<ValidationSuccess>> {
    return this.repository.transaction(async (transaction) => {
      const release = await transaction.loadReleaseRecord(releaseId, true);
      if (release === null) return err(notFound("Content release", releaseId));
      if (release.status !== "DRAFT") {
        return err(invalidState("Content release", release.status, "DRAFT"));
      }

      const snapshot = await transaction.loadCatalogSnapshot(releaseId);
      if (snapshot === null) return err(notFound("Content release snapshot", releaseId));
      const validation = validateReleaseSnapshot(snapshot);
      if (!validation.valid) {
        return err(
          appError("VALIDATION_FAILED", "Content release validation failed", {
            issues: validation.issues,
          }),
        );
      }

      const fingerprint = fingerprintCatalog(snapshot);
      await transaction.setReleaseValidated(releaseId, validation, fingerprint);
      return ok({ fingerprint, report: validation });
    });
  }

  public async publishRelease(releaseId: string): Promise<Result<{ readonly releaseId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const release = await transaction.loadReleaseRecord(releaseId, true);
      if (release === null) return err(notFound("Content release", releaseId));
      if (release.status !== "VALIDATED") {
        return err(invalidState("Content release", release.status, "VALIDATED"));
      }

      const snapshot = await transaction.loadCatalogSnapshot(releaseId);
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

      await transaction.setReleasePublished(releaseId);
      return ok({ releaseId });
    });
  }

  public async activateRelease(releaseId: string): Promise<Result<{ readonly releaseId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const release = await transaction.loadReleaseRecord(releaseId, true);
      if (release === null) return err(notFound("Content release", releaseId));
      if (release.status !== "PUBLISHED") {
        return err(invalidState("Content release", release.status, "PUBLISHED"));
      }
      await transaction.activateRelease(releaseId);
      return ok({ releaseId });
    });
  }

  public async rollbackActiveRelease(
    targetReleaseId: string,
  ): Promise<Result<{ readonly fromReleaseId: string | null; readonly toReleaseId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const target = await transaction.loadReleaseRecord(targetReleaseId, true);
      if (target === null) return err(notFound("Content release", targetReleaseId));
      if (target.status !== "PUBLISHED") {
        return err(invalidState("Content release", target.status, "PUBLISHED"));
      }
      const previous = await transaction.activeReleaseId();
      await transaction.activateRelease(targetReleaseId);
      return ok({ fromReleaseId: previous, toReleaseId: targetReleaseId });
    });
  }

  public async archiveRelease(releaseId: string): Promise<Result<{ readonly releaseId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const release = await transaction.loadReleaseRecord(releaseId, true);
      if (release === null) return err(notFound("Content release", releaseId));
      if (release.status !== "PUBLISHED") {
        return err(invalidState("Content release", release.status, "PUBLISHED"));
      }
      const active = await transaction.activeReleaseId();
      if (active === releaseId) {
        return err(
          appError("INVALID_STATE_TRANSITION", "Active content release cannot be archived", {
            releaseId,
          }),
        );
      }
      await transaction.setReleaseArchived(releaseId);
      return ok({ releaseId });
    });
  }

  public async clonePublishedRelease(input: {
    readonly parentReleaseId: string;
    readonly newReleaseId: string;
    readonly releaseNo: bigint;
    readonly name: string;
  }): Promise<Result<{ readonly releaseId: string }>> {
    return this.repository.transaction(async (transaction) => {
      const parent = await transaction.loadReleaseRecord(input.parentReleaseId, true);
      if (parent === null) return err(notFound("Parent content release", input.parentReleaseId));
      if (parent.status !== "PUBLISHED" && parent.status !== "ARCHIVED") {
        return err(invalidState("Parent content release", parent.status, "PUBLISHED or ARCHIVED"));
      }
      await transaction.cloneRelease(input);
      return ok({ releaseId: input.newReleaseId });
    });
  }

  public async diffReleases(
    fromReleaseId: string,
    toReleaseId: string,
  ): Promise<Result<ReleaseDiff>> {
    return this.repository.read(async (transaction) => {
      const [from, to] = await Promise.all([
        transaction.loadCatalogSnapshot(fromReleaseId),
        transaction.loadCatalogSnapshot(toReleaseId),
      ]);
      if (from === null) return err(notFound("Content release", fromReleaseId));
      if (to === null) return err(notFound("Content release", toReleaseId));
      return ok(diffCatalogSnapshots(from, to));
    });
  }
}

export type { CatalogSnapshot };
