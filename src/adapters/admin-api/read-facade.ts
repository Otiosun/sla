import { z } from "zod";
import type { ContentLibrarySearchResultView } from "../../modules/admin/content-library-contracts.js";
import type { ContentLibraryService } from "../../modules/admin/content-library-service.js";
import type {
  Player360SearchResultView,
  Player360View,
} from "../../modules/admin/player360-contracts.js";
import type { Player360Service } from "../../modules/admin/player360-service.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";

export const AdminApiPrincipalContextSchema = z
  .object({
    principalId: z.string().uuid(),
    environment: z.string().trim().min(1).max(32),
    correlationId: z.string().uuid(),
  })
  .strict();

export type AdminApiPrincipalContext = z.infer<typeof AdminApiPrincipalContextSchema>;

type Player360Reader = Pick<Player360Service, "get" | "search">;
type ContentLibraryReader = Pick<ContentLibraryService, "search">;

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as UnknownRecord;
}

function stripClientAuthority(value: unknown): UnknownRecord {
  const source = asRecord(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "principalId" || key === "environment" || key === "correlationId") continue;
    sanitized[key] = entry;
  }
  return sanitized;
}

function parsePrincipalContext(rawContext: unknown): AdminApiPrincipalContext {
  const parsed = AdminApiPrincipalContextSchema.safeParse(rawContext);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.AUTHORIZATION_DENIED,
      "Invalid administrative session context",
    );
  }
  return parsed.data;
}

/**
 * Transport-neutral boundary between an authenticated admin request and the
 * canonical read services. HTTP/framework code must stay outside this class.
 *
 * Critical invariant: browser-controlled input can never select principalId,
 * environment or correlationId. Those values are injected from trusted server
 * context.
 */
export class AdminReadFacade {
  public constructor(
    private readonly player360: Player360Reader,
    private readonly contentLibrary?: ContentLibraryReader,
  ) {}

  public async searchPlayers(
    rawContext: unknown,
    clientQuery: unknown,
  ): Promise<Player360SearchResultView> {
    const context = parsePrincipalContext(rawContext);
    return this.player360.search({
      ...stripClientAuthority(clientQuery),
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }

  public async getPlayer(
    rawContext: unknown,
    playerId: string,
    clientQuery: unknown,
  ): Promise<Player360View> {
    const context = parsePrincipalContext(rawContext);
    return this.player360.get({
      ...stripClientAuthority(clientQuery),
      principalId: context.principalId,
      correlationId: context.correlationId,
      playerId,
    });
  }

  public async searchContent(
    rawContext: unknown,
    clientQuery: unknown,
  ): Promise<ContentLibrarySearchResultView> {
    const context = parsePrincipalContext(rawContext);
    if (this.contentLibrary === undefined) {
      throw new Error("Content library reader is not configured");
    }
    return this.contentLibrary.search({
      ...stripClientAuthority(clientQuery),
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }
}
