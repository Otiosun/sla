import { z } from "zod";
import type {
  ContentLibrarySearchResultView,
  ContentUnpublishedReleaseView,
} from "../../modules/admin/content-library-contracts.js";
import type { ContentLibraryService } from "../../modules/admin/content-library-service.js";
import type { ContentReleaseReadService } from "../../modules/admin/content-release-read-service.js";
import { AdminEnvironmentSchema } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { IncidentCenterView } from "../../modules/admin/incident-center-read-contracts.js";
import type { IncidentCenterReadService } from "../../modules/admin/incident-center-read-service.js";
import type { MessagingOperationsView } from "../../modules/admin/messaging-operations-read-contracts.js";
import type { MessagingOperationsReadService } from "../../modules/admin/messaging-operations-read-service.js";
import type {
  Player360SearchResultView,
  Player360View,
} from "../../modules/admin/player360-contracts.js";
import type { Player360Service } from "../../modules/admin/player360-service.js";
import type { RuntimeWhatsappHealthView } from "../../modules/admin/runtime-health-contracts.js";
import type { RuntimeWhatsappHealthService } from "../../modules/admin/runtime-health-service.js";
import type { ValidationReport } from "../../modules/catalog/contracts.js";
import type { ReleaseDiff } from "../../modules/catalog/diff.js";

export const AdminApiPrincipalContextSchema = z
  .object({
    principalId: z.string().uuid(),
    environment: z.string().trim().min(1).max(32),
    correlationId: z.string().uuid(),
  })
  .strict();

export type AdminApiPrincipalContext = z.infer<typeof AdminApiPrincipalContextSchema>;

type Player360Reader = Pick<Player360Service, "get" | "search">;
type ContentLibraryReader = Pick<ContentLibraryService, "search" | "listUnpublished">;
type ContentReleaseReader = Pick<ContentReleaseReadService, "diff" | "validationPreview">;
type RuntimeHealthReader = Pick<RuntimeWhatsappHealthService, "getLatest">;
type MessagingOperationsReader = Pick<MessagingOperationsReadService, "getSnapshot">;
type IncidentCenterReader = Pick<IncidentCenterReadService, "getSnapshot">;

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
    private readonly contentRelease?: ContentReleaseReader,
    private readonly runtimeHealth?: RuntimeHealthReader,
    private readonly messagingOperations?: MessagingOperationsReader,
    private readonly incidentCenter?: IncidentCenterReader,
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

  public async listUnpublishedContent(
    rawContext: unknown,
  ): Promise<readonly ContentUnpublishedReleaseView[]> {
    const context = parsePrincipalContext(rawContext);
    if (this.contentLibrary === undefined) {
      throw new Error("Content library reader is not configured");
    }
    return this.contentLibrary.listUnpublished({
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }

  public async diffContentRelease(rawContext: unknown, clientQuery: unknown): Promise<ReleaseDiff> {
    const context = parsePrincipalContext(rawContext);
    if (this.contentRelease === undefined) {
      throw new Error("Content release read boundary is not configured");
    }
    return this.contentRelease.diff({
      ...stripClientAuthority(clientQuery),
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }

  public async previewContentReleaseValidation(
    rawContext: unknown,
    releaseId: string,
  ): Promise<ValidationReport> {
    const context = parsePrincipalContext(rawContext);
    if (this.contentRelease === undefined) {
      throw new Error("Content release read boundary is not configured");
    }
    return this.contentRelease.validationPreview({
      principalId: context.principalId,
      correlationId: context.correlationId,
      releaseId,
    });
  }

  public async getRuntimeWhatsappHealth(rawContext: unknown): Promise<RuntimeWhatsappHealthView> {
    const context = parsePrincipalContext(rawContext);
    if (this.runtimeHealth === undefined) {
      throw new Error("Runtime health read boundary is not configured");
    }
    return this.runtimeHealth.getLatest({
      principalId: context.principalId,
      environment: AdminEnvironmentSchema.parse(context.environment),
      correlationId: context.correlationId,
    });
  }

  public async getMessagingOperations(rawContext: unknown): Promise<MessagingOperationsView> {
    const context = parsePrincipalContext(rawContext);
    if (this.messagingOperations === undefined) {
      throw new Error("Messaging operations read boundary is not configured");
    }
    return this.messagingOperations.getSnapshot({
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }

  public async getIncidentCenter(rawContext: unknown): Promise<IncidentCenterView> {
    const context = parsePrincipalContext(rawContext);
    if (this.incidentCenter === undefined) {
      throw new Error("Incident Center read boundary is not configured");
    }
    return this.incidentCenter.getSnapshot({
      principalId: context.principalId,
      correlationId: context.correlationId,
    });
  }
}
