import type {
  ContentLibraryCursor,
  ContentLibrarySearchRequest,
  ContentLibrarySearchResultView,
  ContentUnpublishedReleaseView,
} from "./content-library-contracts.js";

export type ContentLibraryRepositorySearch = Omit<
  ContentLibrarySearchRequest,
  "principalId" | "correlationId" | "cursor"
> & {
  readonly cursor: ContentLibraryCursor | null;
};

export interface ContentLibraryRepository {
  searchContent(input: ContentLibraryRepositorySearch): Promise<ContentLibrarySearchResultView>;
  listUnpublished(): Promise<readonly ContentUnpublishedReleaseView[]>;
}
