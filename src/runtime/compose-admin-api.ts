import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { CloudflareAccessJwtVerifier } from "../adapters/admin-api/cloudflare-access-verifier.js";
import { createAdminApiServer } from "../adapters/admin-api/fastify-server.js";
import { AdminIdentityResolver } from "../adapters/admin-api/identity-resolver.js";
import { AdminReadFacade } from "../adapters/admin-api/read-facade.js";
import { AdminRequestAuthenticator } from "../adapters/admin-api/request-authenticator.js";
import { AdminSessionService } from "../adapters/admin-api/session-service.js";
import { createPhase12AdminOperationRegistry } from "../modules/admin/definitions.js";
import { Player360Service } from "../modules/admin/player360-service.js";
import { AdminService } from "../modules/admin/service.js";
import { PostgresAdminIdentityRepository } from "../platform/admin/postgres-admin-identity-repository.js";
import { PostgresAdminRepository } from "../platform/admin/postgres-admin-repository.js";
import { PostgresPlayer360Repository } from "../platform/admin/postgres-player360-repository.js";
import type { AppConfig } from "../platform/config/env.js";

export interface OperationalAdminApi {
  readonly server: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function adminEnvironment(
  appEnv: AppConfig["appEnv"],
): "development" | "staging" | "production" {
  if (appEnv === "staging" || appEnv === "production") return appEnv;
  return "development";
}

export function createOperationalAdminApi(pool: Pool, config: AppConfig): OperationalAdminApi | null {
  if (!config.adminApiEnabled) return null;
  if (
    config.adminApiAllowedOrigin === null ||
    config.adminAccessTeamDomain === null ||
    config.adminAccessAudience === null
  ) {
    throw new Error("Enabled Admin API is missing validated identity/origin configuration");
  }

  const adminRepository = new PostgresAdminRepository(pool);
  const registry = createPhase12AdminOperationRegistry(adminRepository);
  const adminService = new AdminService(registry, adminRepository);
  const player360Repository = new PostgresPlayer360Repository(pool);
  const player360Service = new Player360Service(adminService, player360Repository);
  const readFacade = new AdminReadFacade(player360Service);

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
  const sessionService = new AdminSessionService(adminRepository, identityRepository);
  const server = createAdminApiServer({
    allowedOrigin: config.adminApiAllowedOrigin,
    authenticator,
    sessionService,
    readFacade,
  });

  return {
    server,
    listen: () => server.listen({ host: config.adminApiHost, port: config.adminApiPort }),
    close: () => server.close(),
  };
}
