import { z } from "zod";
import { ContentLifecycleStatusSchema } from "../catalog/contracts.js";
import { CatalogDraftResourceKindSchema } from "../catalog/draft-contracts.js";

export const ContentLibrarySearchRequestSchema = z
  .object({
    principalId: z.string().uuid(),
    correlationId: z.string().uuid(),
    query: z.string().trim().min(1).max(120).optional(),
    resourceKind: CatalogDraftResourceKindSchema.optional(),
    releaseStatus: ContentLifecycleStatusSchema.optional(),
    active: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z.string().trim().min(1).max(768).optional(),
  })
  .strict();
export type ContentLibrarySearchRequest = z.infer<typeof ContentLibrarySearchRequestSchema>;

export interface ContentLibraryItemView {
  readonly releaseId: string;
  readonly releaseNo: string;
  readonly releaseName: string;
  readonly releaseStatus: "DRAFT" | "VALIDATED" | "PUBLISHED" | "ARCHIVED";
  readonly releaseRevision: string;
  readonly resourceKind: z.infer<typeof CatalogDraftResourceKindSchema>;
  readonly resourceId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly active: boolean;
}

export interface ContentLibrarySearchResultView {
  readonly items: readonly ContentLibraryItemView[];
  readonly nextCursor: string | null;
}

export const ContentLibraryCursorSchema = z
  .object({
    releaseNo: z.string().regex(/^\d+$/),
    resourceKind: CatalogDraftResourceKindSchema,
    slug: z.string().min(1).max(160),
    resourceId: z.string().uuid(),
  })
  .strict();
export type ContentLibraryCursor = z.infer<typeof ContentLibraryCursorSchema>;
