import type {
  ContentLibraryCursor,
  ContentLibrarySearchRequest,
  ContentLibrarySearchResultView,
} from "./content-library-contracts.js";

export type ContentLibraryRepositorySearch = Omit<
  ContentLibrarySearchRequest,
  "principalId" | "correlationId" | "cursor"
> & {
  readonly cursor: ContentLibraryCursor | null;
};

export interface ContentLibraryRepository {
  searchContent(input: ContentLibraryRepositorySearch): Promise<ContentLibrarySearchResultView>;
}
