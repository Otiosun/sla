import {
  ContentLibrarySearchRequestSchema,
  ContentUnpublishedStateRequestSchema,
  decodeContentLibraryCursor,
  type ContentLibrarySearchResultView,
  type ContentUnpublishedReleaseView,
} from "./content-library-contracts.js";
import type { ContentLibraryRepository } from "./content-library-ports.js";
import { ADMIN_ERROR_CODES, AdminError } from "./errors.js";
import type { AdminService } from "./service.js";

const AUTHORIZATION_OPERATIONS = [
  "content.library.search.create",
  "content.library.search.edit",
  "content.library.search.validate",
  "content.library.search.publish",
] as const;

type ContentLibraryAuthorizer = Pick<AdminService, "authorizeRead">;

function isAuthorizationDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === ADMIN_ERROR_CODES.AUTHORIZATION_DENIED
  );
}

export class ContentLibraryService {
  public constructor(
    private readonly authorizer: ContentLibraryAuthorizer,
    private readonly repository: ContentLibraryRepository,
  ) {}

  private async authorize(principalId: string, correlationId: string): Promise<void> {
    let denied: unknown = null;
    for (const operationType of AUTHORIZATION_OPERATIONS) {
      try {
        await this.authorizer.authorizeRead({
          principalId,
          operationType,
          input: {},
          correlationId,
        });
        denied = null;
        break;
      } catch (error) {
        if (!isAuthorizationDenied(error)) throw error;
        denied = error;
      }
    }
    if (denied !== null) throw denied;
  }

  public async search(rawRequest: unknown): Promise<ContentLibrarySearchResultView> {
    const parsed = ContentLibrarySearchRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid content library search");
    }

    const cursor =
      parsed.data.cursor === undefined ? null : decodeContentLibraryCursor(parsed.data.cursor);
    if (parsed.data.cursor !== undefined && cursor === null) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid content library cursor");
    }

    await this.authorize(parsed.data.principalId, parsed.data.correlationId);

    return this.repository.searchContent({
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      ...(parsed.data.resourceKind === undefined ? {} : { resourceKind: parsed.data.resourceKind }),
      ...(parsed.data.releaseStatus === undefined
        ? {}
        : { releaseStatus: parsed.data.releaseStatus }),
      ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
      limit: parsed.data.limit,
      cursor,
    });
  }

  public async listUnpublished(rawRequest: unknown): Promise<readonly ContentUnpublishedReleaseView[]> {
    const parsed = ContentUnpublishedStateRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid unpublished content read");
    }

    await this.authorize(parsed.data.principalId, parsed.data.correlationId);
    return this.repository.listUnpublished();
  }
}
