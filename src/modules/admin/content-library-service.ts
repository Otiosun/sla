import {
  ContentLibrarySearchRequestSchema,
  type ContentLibrarySearchResultView,
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

  public async search(rawRequest: unknown): Promise<ContentLibrarySearchResultView> {
    const parsed = ContentLibrarySearchRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid content library search");
    }

    let denied: unknown = null;
    for (const operationType of AUTHORIZATION_OPERATIONS) {
      try {
        await this.authorizer.authorizeRead({
          principalId: parsed.data.principalId,
          operationType,
          input: {},
          correlationId: parsed.data.correlationId,
        });
        denied = null;
        break;
      } catch (error) {
        if (!isAuthorizationDenied(error)) throw error;
        denied = error;
      }
    }
    if (denied !== null) throw denied;

    return this.repository.searchContent({
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
      ...(parsed.data.resourceKind === undefined ? {} : { resourceKind: parsed.data.resourceKind }),
      ...(parsed.data.releaseStatus === undefined
        ? {}
        : { releaseStatus: parsed.data.releaseStatus }),
      ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
  }
}
