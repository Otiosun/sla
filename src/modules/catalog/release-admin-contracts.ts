import { z } from "zod";
import type { ReleaseDiff } from "./diff.js";

export const CatalogReleaseLifecycleOperationSchema = z.enum(["VALIDATE", "PUBLISH"]);
export type CatalogReleaseLifecycleOperation = z.infer<
  typeof CatalogReleaseLifecycleOperationSchema
>;

export const CatalogReleaseDiffInputSchema = z
  .object({
    fromReleaseId: z.string().uuid(),
    toReleaseId: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.fromReleaseId !== value.toReleaseId, {
    message: "Release diff requires two distinct releases",
    path: ["toReleaseId"],
  });
export type CatalogReleaseDiffInput = z.infer<typeof CatalogReleaseDiffInputSchema>;

export const CatalogReleaseLifecycleInputSchema = z
  .object({ releaseId: z.string().uuid() })
  .strict();
export type CatalogReleaseLifecycleInput = z.infer<typeof CatalogReleaseLifecycleInputSchema>;

export interface CatalogReleaseMutationMetadata {
  readonly sourceType: "ADMIN_OPERATION" | "SYSTEM";
  readonly sourceId: string;
  readonly reason: string;
  readonly actorType: "ADMIN" | "SYSTEM";
  readonly actorId: string | null;
}

export interface CatalogReleaseOwnerMutationContext {
  readonly expectedRevision: bigint;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly metadata: CatalogReleaseMutationMetadata;
}

export interface CatalogReleaseLifecycleState extends Readonly<Record<string, unknown>> {
  readonly releaseId: string;
  readonly status: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly revision: string;
  readonly parentReleaseId: string | null;
  readonly defaultRulesetId: string;
  readonly contentFingerprint: string | null;
}

export interface CatalogReleaseLifecycleMutationResult {
  readonly operationKind: CatalogReleaseLifecycleOperation;
  readonly releaseId: string;
  readonly revision: string;
  readonly beforeStatus: "DRAFT" | "VALIDATED";
  readonly afterStatus: "VALIDATED" | "PUBLISHED";
  readonly fingerprint: string;
  readonly beforeData: CatalogReleaseLifecycleState;
  readonly afterData: CatalogReleaseLifecycleState;
  readonly replayed: boolean;
}

export interface CatalogReleasePublishPreview {
  readonly releaseId: string;
  readonly revision: string;
  readonly parentReleaseId: string | null;
  readonly fingerprint: string;
  readonly before: CatalogReleaseLifecycleState;
  readonly after: CatalogReleaseLifecycleState;
  readonly diff: ReleaseDiff | null;
}

export interface CatalogReleaseAdminClaim {
  readonly operationKind: CatalogReleaseLifecycleOperation;
  readonly releaseId: string;
  readonly requestFingerprint: string;
  readonly expectedRevision: bigint;
  readonly beforeStatus: "DRAFT" | "VALIDATED";
  readonly afterStatus: "VALIDATED" | "PUBLISHED";
  readonly beforeData: CatalogReleaseLifecycleState;
  readonly afterData: CatalogReleaseLifecycleState;
  readonly result: CatalogReleaseLifecycleMutationResult;
}

export interface CatalogReleaseAdminClaimInsert extends CatalogReleaseAdminClaim {
  readonly idempotencyKey: string;
  readonly correlationId: string;
}
