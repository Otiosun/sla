import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { AdminAccessSessionGuard } from "../adapters/admin-api/access-session-guard.js";
import { CloudflareAccessJwtVerifier } from "../adapters/admin-api/cloudflare-access-verifier.js";
import { createAdminApiServer } from "../adapters/admin-api/fastify-server.js";
import { AdminIdentityResolver } from "../adapters/admin-api/identity-resolver.js";
import { AdminMutationFacade } from "../adapters/admin-api/mutation-facade.js";
import { AdminReadFacade } from "../adapters/admin-api/read-facade.js";
import { AdminRequestAuthenticator } from "../adapters/admin-api/request-authenticator.js";
import { AdminSessionLogoutService } from "../adapters/admin-api/session-logout-service.js";
import { AdminSessionService } from "../adapters/admin-api/session-service.js";
import { ExternalAdminMutationEndpoint } from "../modules/anti-abuse/external-admin-endpoint.js";
import { AdminOperationAuditReadService } from "../modules/admin/admin-operation-audit-read-service.js";
import {
  registerCatalogReleaseDiffRead,
  registerCatalogReleaseValidationPreviewRead,
} from "../modules/admin/catalog-release-definitions.js";
import { ContentLibraryService } from "../modules/admin/content-library-service.js";
import { ContentReleaseReadService } from "../modules/admin/content-release-read-service.js";
import { createPhase12AdminOperationRegistry } from "../modules/admin/definitions.js";
import { registerEconomyAnalyticsRead } from "../modules/admin/economy-analytics-definitions.js";
import { EconomyAnalyticsService } from "../modules/admin/economy-analytics-service.js";
import { registerIncidentCenterRead } from "../modules/admin/incident-center-definitions.js";
import { IncidentCenterReadService } from "../modules/admin/incident-center-read-service.js";
import { registerMessagingOperationsRead } from "../modules/admin/messaging-operations-definitions.js";
import { MessagingOperationsReadService } from "../modules/admin/messaging-operations-read-service.js";
import { AdminOperationRegistry } from "../modules/admin/operation-registry.js";
import { registerPlayerActivityAnalyticsRead } from "../modules/admin/player-activity-analytics-definitions.js";
import { PlayerActivityAnalyticsService } from "../modules/admin/player-activity-analytics-service.js";
import { Player360Service } from "../modules/admin/player360-service.js";
import { registerRuntimeWhatsappHealthRead } from "../modules/admin/runtime-health-definitions.js";
import { RuntimeWhatsappHealthService } from "../modules/admin/runtime-health-service.js";
import { AdminService } from "../modules/admin/service.js";
import { CatalogReleaseAdminService } from "../modules/catalog/release-admin-service.js";
import { PostgresAdminAccessSessionRepository } from "../platform/admin/postgres-admin-access-session-repository.js";
import { PostgresAdminApiRateLimiter } from "../platform/admin/postgres-admin-api-rate-limiter.js";
import { PostgresAdminIdentityRepository } from "../platform/admin/postgres-admin-identity-repository.js";
import { PostgresAdminOperationAuditReadRepository } from "../platform/admin/postgres-admin-operation-audit-read-repository.js";
import { PostgresAdminRepository } from "../platform/admin/postgres-admin-repository.js";
import { PostgresAdminSessionRevocationPort } from "../platform/admin/postgres-admin-session-revocation-port.js";
import { PostgresEconomyAnalyticsRepository } from "../platform/admin/postgres-economy-analytics-repository.js";
import { PostgresIncidentCenterReadRepository } from "../platform/admin/postgres-incident-center-read-repository.js";
import { PostgresMessagingOperationsReadRepository } from "../platform/admin/postgres-messaging-operations-read-repository.js";
import { PostgresPlayerActivityAnalyticsRepository } from "../platform/admin/postgres-player-activity-analytics-repository.js";
import { PostgresPlayer360Repository } from "../platform/admin/postgres-player360-repository.js";
import { PostgresRuntimeWhatsappHealthRepository } from "../platform/admin/postgres-runtime-whatsapp-health-repository.js";
import { PostgresMutationAdmission } from "../platform/anti-abuse/postgres-mutation-admission.js";
import { PostgresCatalogReleaseAdminRepository } from "../platform/catalog/postgres-catalog-release-admin-repository.js";
import { PostgresContentLibraryRepository } from "../platform/catalog/postgres-content-library-repository.js";
import { SystemClock } from "../platform/clock/index.js";
import type { AppConfig } from "../platform/config/env.js";

export interface OperationalAdminApi {
  readonly server: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function adminEnvironment(appEnv: AppConfig["appEnv"]): "development" | "staging" | "production" {
  if (appEnv === "staging" || appEnv === "production") return appEnv;
  return "development";
}

export function createOperationalAdminApi(
  pool: Pool,
  config: AppConfig,
): OperationalAdminApi | null {
  if (!config.adminApiEnabled) return null;
  if (
    config.adminApiAllowedOrigin === null ||
    config.adminAccessTeamDomain === null ||
    config.adminAccessAudience === null
  ) {
    throw new Error("Enabled Admin API is missing validated identity/origin configuration");
  }
  if (
    (config.appEnv === "staging" || config.appEnv === "production") &&
    config.adminAccessPrivilegedAudience === null
  ) {
    throw new Error("Enabled Admin API is missing validated privileged Access configuration");
  }

  const adminRepository = new PostgresAdminRepository(pool);
  const sessionRevocationPort = new PostgresAdminSessionRevocationPort(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository, sessionRevocationPort);
  const adminService = new AdminService(registry, adminRepository);
  const player360Repository = new PostgresPlayer360Repository(pool);
  const player360Service = new Player360Service(adminService, player360Repository);
  const playerActivityAnalyticsReadRegistry = registerPlayerActivityAnalyticsRead(
    new AdminOperationRegistry(),
  );
  const playerActivityAnalyticsReadService = new AdminService(
    playerActivityAnalyticsReadRegistry,
    adminRepository,
  );
  const playerActivityAnalyticsService = new PlayerActivityAnalyticsService(
    playerActivityAnalyticsReadService,
    new PostgresPlayerActivityAnalyticsRepository(pool),
  );
  const economyAnalyticsReadRegistry = registerEconomyAnalyticsRead(new AdminOperationRegistry());
  const economyAnalyticsReadService = new AdminService(economyAnalyticsReadRegistry, adminRepository);
  const economyAnalyticsService = new EconomyAnalyticsService(
    economyAnalyticsReadService,
    new PostgresEconomyAnalyticsRepository(pool),
  );
  const contentLibraryRepository = new PostgresContentLibraryRepository(pool);
  const contentLibraryService = new ContentLibraryService(adminService, contentLibraryRepository);
  const catalogReleaseRepository = new PostgresCatalogReleaseAdminRepository(pool);
  const catalogReleaseOwner = new CatalogReleaseAdminService(catalogReleaseRepository);
  const contentReleaseReadRegistry = registerCatalogReleaseValidationPreviewRead(
    registerCatalogReleaseDiffRead(new AdminOperationRegistry()),
  );
  const contentReleaseReadAuthorizer = new AdminService(
    contentReleaseReadRegistry,
    adminRepository,
  );
  const contentReleaseReadService = new ContentReleaseReadService(
    contentReleaseReadAuthorizer,
    catalogReleaseOwner,
  );
  const runtimeHealthReadRegistry = registerRuntimeWhatsappHealthRead(new AdminOperationRegistry());
  const runtimeHealthReadAuthorizer = new AdminService(runtimeHealthReadRegistry, adminRepository);
  const runtimeHealthReadService = new RuntimeWhatsappHealthService(
    runtimeHealthReadAuthorizer,
    new PostgresRuntimeWhatsappHealthRepository(pool),
  );
  const messagingOperationsReadRegistry = registerMessagingOperationsRead(
    new AdminOperationRegistry(),
  );
  const messagingOperationsReadAuthorizer = new AdminService(
    messagingOperationsReadRegistry,
    adminRepository,
  );
  const messagingOperationsReadService = new MessagingOperationsReadService(
    messagingOperationsReadAuthorizer,
    new PostgresMessagingOperationsReadRepository(pool),
  );
  const incidentCenterReadRegistry = registerIncidentCenterRead(new AdminOperationRegistry());
  const incidentCenterReadAuthorizer = new AdminService(
    incidentCenterReadRegistry,
    adminRepository,
  );
  const incidentCenterReadService = new IncidentCenterReadService(
    incidentCenterReadAuthorizer,
    new PostgresIncidentCenterReadRepository(pool),
  );
  const adminOperationAuditReadService = new AdminOperationAuditReadService(
    adminService,
    new PostgresAdminOperationAuditReadRepository(pool),
  );
  const readFacade = new AdminReadFacade(
    player360Service,
    contentLibraryService,
    contentReleaseReadService,
    runtimeHealthReadService,
    messagingOperationsReadService,
    incidentCenterReadService,
    adminOperationAuditReadService,
    playerActivityAnalyticsService,
    economyAnalyticsService,
  );
  const mutationEndpoint = new ExternalAdminMutationEndpoint(
    adminService,
    new PostgresMutationAdmission(pool),
  );
  const mutationFacade = new AdminMutationFacade(mutationEndpoint);

  const identityRepository = new PostgresAdminIdentityRepository(pool);
  const identityResolver = new AdminIdentityResolver(
    identityRepository,
    adminEnvironment(config.appEnv),
  );
  const accessVerifier = new CloudflareAccessJwtVerifier({
    teamDomain: config.adminAccessTeamDomain,
    audience: config.adminAccessAudience,
  });
  const authenticator = new AdminRequestAuthenticator(accessVerifier, identityResolver);
  const privilegedAuthenticator =
    config.adminAccessPrivilegedAudience === null
      ? undefined
      : new AdminRequestAuthenticator(
          new CloudflareAccessJwtVerifier({
            teamDomain: config.adminAccessTeamDomain,
            audience: config.adminAccessPrivilegedAudience,
          }),
          identityResolver,
        );
  const accessSessionRepository = new PostgresAdminAccessSessionRepository(pool);
  const clock = new SystemClock();
  const sessionGuard = new AdminAccessSessionGuard(
    accessSessionRepository,
    clock,
    config.adminAccessSessionIdleTimeoutMs,
  );
  const sessionLogoutService = new AdminSessionLogoutService(accessSessionRepository, clock);
  const sessionService = new AdminSessionService(adminRepository, identityRepository);
  const rateLimiter = new PostgresAdminApiRateLimiter(pool);
  const server = createAdminApiServer({
    allowedOrigin: config.adminApiAllowedOrigin,
    authenticator,
    ...(privilegedAuthenticator === undefined ? {} : { privilegedAuthenticator }),
    sessionGuard,
    sessionLogoutService,
    sessionService,
    readFacade,
    mutationFacade,
    rateLimiter,
  });

  return {
    server,
    listen: () => server.listen({ host: config.adminApiHost, port: config.adminApiPort }),
    close: () => server.close(),
  };
}
