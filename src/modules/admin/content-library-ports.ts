import type {
  ContentLibrarySearchRequest,
  ContentLibrarySearchResultView,
} from "./content-library-contracts.js";

export type ContentLibraryRepositorySearch = Omit<
  ContentLibrarySearchRequest,
  "principalId" | "correlationId" | "cursor"
> & {
  readonly cursor: string | null;
};

export interface ContentLibraryRepository {
  searchContent(input: ContentLibraryRepositorySearch): Promise<ContentLibrarySearchResultView>;
}
