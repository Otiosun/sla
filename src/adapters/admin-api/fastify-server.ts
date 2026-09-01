import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminPreparedOperation } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { AdminAccessSessionGuard } from "./access-session-guard.js";
import { mapAdminHttpError } from "./http-error-mapper.js";
import type { ResolvedAdminIdentityContext } from "./identity-resolver.js";
import type { AdminMutationFacade } from "./mutation-facade.js";
import type { AdminReadFacade } from "./read-facade.js";
import {
  type AdminRequestAuthenticator,
  type AuthenticatedAdminRequestContext,
  AdminUnauthenticatedError,
} from "./request-authenticator.js";
import type { AdminSessionLogoutService } from "./session-logout-service.js";
import type { AdminSessionService } from "./session-service.js";

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");
const CONTROL_CENTER_CSRF_HEADER = "x-control-center-csrf";
const CONTROL_CENTER_CSRF_VALUE = "1";
const CONTROL_CENTER_MUTATION_ALLOW_HEADERS = `content-type,${CONTROL_CENTER_CSRF_HEADER}`;
const UNSAFE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const PlayerSearchTransportSchema = z
  .object({
    status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
    trainerNamePrefix: z.string().trim().min(1).max(80).optional(),
    originRegionId: z.string().uuid().optional(),
    identityProvider: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
    externalId: z.string().trim().min(1).max(256).optional(),
    includeSensitive: booleanQuery.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const PlayerGetTransportSchema = z
  .object({
    includeSensitive: booleanQuery.optional(),
  })
  .strict();

const ContentLibraryTransportSchema = z
  .object({
    query: z.string().trim().min(1).max(120).optional(),
    resourceKind: z
      .enum(["SPECIES", "MOVE", "ITEM", "AREA", "ENCOUNTER_TABLE", "REWARD", "EFFECT"])
      .optional(),
    releaseStatus: z.enum(["DRAFT", "VALIDATED", "PUBLISHED", "ARCHIVED"]).optional(),
    active: booleanQuery.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(768).optional(),
  })
  .strict();

const ContentUnpublishedTransportSchema = z.object({}).strict();
const ContentReleaseDiffTransportSchema = z
  .object({
    fromReleaseId: z.string().uuid(),
    toReleaseId: z.string().uuid(),
  })
  .strict()
  .refine((value) => value.fromReleaseId !== value.toReleaseId, {
    message: "Release diff requires two distinct releases",
    path: ["toReleaseId"],
  });
const ContentReleaseValidationTransportSchema = z.object({}).strict();
const RuntimeWhatsappHealthTransportSchema = z.object({}).strict();
const MessagingOperationsTransportSchema = z.object({}).strict();
const ContentReleaseParamsSchema = z.object({ releaseId: z.string().uuid() }).strict();
const PlayerParamsSchema = z.object({ playerId: z.string().uuid() }).strict();

export type AdminApiRateLimitedOperation =
  | "session.read"
  | "player.search"
  | "player.read"
  | "content.search"
  | "runtime.health.read"
  | "messaging.operations.read"
  | "mutation.prepare";

export interface AdminApiRateLimitRequest {
  readonly principalId: string;
  readonly operation: AdminApiRateLimitedOperation;
}

export interface AdminApiRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface AdminApiRateLimiter {
  consume(request: AdminApiRateLimitRequest): Promise<AdminApiRateLimitDecision>;
}

export interface AdminApiServerDependencies {
  readonly allowedOrigin: string;
  readonly authenticator: Pick<AdminRequestAuthenticator, "authenticate">;
  readonly privilegedAuthenticator?: Pick<AdminRequestAuthenticator, "authenticate">;
  readonly sessionGuard: Pick<AdminAccessSessionGuard, "authorize">;
  readonly sessionLogoutService?: Pick<AdminSessionLogoutService, "logoutCurrent">;
  readonly sessionService: Pick<AdminSessionService, "getSession">;
  readonly readFacade: Pick<AdminReadFacade, "searchPlayers" | "getPlayer"> &
    Partial<
      Pick<
        AdminReadFacade,
        | "searchContent"
        | "listUnpublishedContent"
        | "diffContentRelease"
        | "previewContentReleaseValidation"
        | "getRuntimeWhatsappHealth"
        | "getMessagingOperations"
      >
    >;
  readonly mutationFacade: Pick<AdminMutationFacade, "prepareMutation">;
  readonly rateLimiter: AdminApiRateLimiter;
}

function invalidTransportInput(): AdminError {
  return new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid administrative request");
}

function parseTransport<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidTransportInput();
  return parsed.data;
}

function accessAssertion(request: FastifyRequest): unknown {
  return request.headers["cf-access-jwt-assertion"];
}

function applyResponseBoundary(reply: FastifyReply, correlationId: string): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-correlation-id", correlationId);
  reply.header("vary", "Origin");
}

function trustedRequestContext(identity: ResolvedAdminIdentityContext, request: FastifyRequest) {
  return {
    principalId: identity.principalId,
    environment: identity.environment,
    correlationId: request.id,
  };
}

function projectPreparedOperation(prepared: AdminPreparedOperation) {
  const operation = prepared.operation;
  return {
    operation: {
      id: operation.id,
      operationType: operation.operationType,
      target: { type: operation.targetType, id: operation.targetId },
      riskTier: operation.riskTier,
      authorizationMode: operation.authorizationMode,
      status: operation.status,
      reason: operation.reason,
      expectedRevision: operation.expectedRevision?.toString() ?? null,
      correlationId: operation.correlationId,
      policy: operation.policy,
      revision: operation.revision.toString(),
    },
    replayed: prepared.replayed,
  };
}

function originDenied(request: FastifyRequest, allowedOrigin: string): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== allowedOrigin) return true;
  return UNSAFE_HTTP_METHODS.has(request.method) && origin !== allowedOrigin;
}

function csrfDenied(request: FastifyRequest): boolean {
  if (!UNSAFE_HTTP_METHODS.has(request.method)) return false;
  return request.headers[CONTROL_CENTER_CSRF_HEADER] !== CONTROL_CENTER_CSRF_VALUE;
}

async function authenticateSession(
  request: FastifyRequest,
  dependencies: AdminApiServerDependencies,
  authenticator: Pick<AdminRequestAuthenticator, "authenticate"> = dependencies.authenticator,
): Promise<AuthenticatedAdminRequestContext> {
  const authenticated = await authenticator.authenticate(accessAssertion(request));
  return dependencies.sessionGuard.authorize(authenticated);
}

async function authenticateAndLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminApiServerDependencies,
  operation: AdminApiRateLimitedOperation,
  authenticator: Pick<AdminRequestAuthenticator, "authenticate"> = dependencies.authenticator,
): Promise<AuthenticatedAdminRequestContext | null> {
  const identity = await authenticateSession(request, dependencies, authenticator);
  const decision = await dependencies.rateLimiter.consume({
    principalId: identity.principalId,
    operation,
  });
  if (decision.allowed) return identity;

  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterSeconds));
  reply.header("retry-after", String(retryAfterSeconds));
  await reply.code(429).send({
    error: {
      code: "ADMIN_RATE_LIMITED",
      message: "Administrative request rate limit exceeded",
      correlationId: request.id,
    },
  });
  return null;
}

export function createAdminApiServer(dependencies: AdminApiServerDependencies): FastifyInstance {
  const server = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 16 * 1024,
    genReqId: () => randomUUID(),
  });

  server.addHook("onRequest", async (request, reply) => {
    const correlationId = request.id;
    applyResponseBoundary(reply, correlationId);

    if (originDenied(request, dependencies.allowedOrigin)) {
      const mapped = mapAdminHttpError(
        new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Origin denied"),
        correlationId,
      );
      await reply.code(mapped.statusCode).send(mapped.body);
      return reply;
    }
    if (csrfDenied(request)) {
      const mapped = mapAdminHttpError(
        new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "CSRF guard denied"),
        correlationId,
      );
      await reply.code(mapped.statusCode).send(mapped.body);
      return reply;
    }
    if (request.headers.origin === dependencies.allowedOrigin) {
      reply.header("access-control-allow-origin", dependencies.allowedOrigin);
      reply.header("access-control-allow-credentials", "true");
    }
  });

  server.setNotFoundHandler(async (request, reply) => {
    const mapped = mapAdminHttpError(
      new AdminError(ADMIN_ERROR_CODES.TARGET_NOT_FOUND, "Administrative route not found"),
      request.id,
    );
    return reply.code(404).send(mapped.body);
  });

  server.setErrorHandler(async (error, request, reply) => {
    const mapped = mapAdminHttpError(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });

  server.get("/admin/v1/session", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "session.read");
    if (identity === null) return reply;
    return dependencies.sessionService.getSession(identity);
  });

  if (dependencies.sessionLogoutService !== undefined) {
    server.post("/admin/v1/session/logout", async (request) => {
      const identity = await authenticateSession(request, dependencies);
      return dependencies.sessionLogoutService?.logoutCurrent(identity);
    });
  }

  server.get("/admin/v1/players", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "player.search");
    if (identity === null) return reply;
    const query = parseTransport(PlayerSearchTransportSchema, request.query);
    return dependencies.readFacade.searchPlayers(trustedRequestContext(identity, request), query);
  });

  server.get("/admin/v1/runtime/whatsapp/health", async (request, reply) => {
    const identity = await authenticateAndLimit(
      request,
      reply,
      dependencies,
      "runtime.health.read",
    );
    if (identity === null) return reply;
    parseTransport(RuntimeWhatsappHealthTransportSchema, request.query);
    if (dependencies.readFacade.getRuntimeWhatsappHealth === undefined) {
      throw new Error("Runtime WhatsApp health read boundary is not configured");
    }
    return dependencies.readFacade.getRuntimeWhatsappHealth(
      trustedRequestContext(identity, request),
    );
  });

  server.get("/admin/v1/messaging/operations", async (request, reply) => {
    const identity = await authenticateAndLimit(
      request,
      reply,
      dependencies,
      "messaging.operations.read",
    );
    if (identity === null) return reply;
    parseTransport(MessagingOperationsTransportSchema, request.query);
    if (dependencies.readFacade.getMessagingOperations === undefined) {
      throw new Error("Messaging operations read boundary is not configured");
    }
    return dependencies.readFacade.getMessagingOperations(
      trustedRequestContext(identity, request),
    );
  });

  server.get("/admin/v1/content/releases/diff", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "content.search");
    if (identity === null) return reply;
    const query = parseTransport(ContentReleaseDiffTransportSchema, request.query);
    if (dependencies.readFacade.diffContentRelease === undefined) {
      throw new Error("Content release diff read boundary is not configured");
    }
    return dependencies.readFacade.diffContentRelease(
      trustedRequestContext(identity, request),
      query,
    );
  });

  server.get("/admin/v1/content/releases/:releaseId/validation", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "content.search");
    if (identity === null) return reply;
    const params = parseTransport(ContentReleaseParamsSchema, request.params);
    parseTransport(ContentReleaseValidationTransportSchema, request.query);
    if (dependencies.readFacade.previewContentReleaseValidation === undefined) {
      throw new Error("Content release validation preview boundary is not configured");
    }
    const report = await dependencies.readFacade.previewContentReleaseValidation(
      trustedRequestContext(identity, request),
      params.releaseId,
    );
    return { releaseId: params.releaseId, ...report };
  });

  server.get("/admin/v1/content/unpublished", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "content.search");
    if (identity === null) return reply;
    parseTransport(ContentUnpublishedTransportSchema, request.query);
    if (dependencies.readFacade.listUnpublishedContent === undefined) {
      throw new Error("Unpublished content read boundary is not configured");
    }
    return dependencies.readFacade.listUnpublishedContent(trustedRequestContext(identity, request));
  });

  server.get("/admin/v1/content", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "content.search");
    if (identity === null) return reply;
    const query = parseTransport(ContentLibraryTransportSchema, request.query);
    if (dependencies.readFacade.searchContent === undefined) {
      throw new Error("Content library read boundary is not configured");
    }
    return dependencies.readFacade.searchContent(trustedRequestContext(identity, request), query);
  });

  server.get("/admin/v1/players/:playerId", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "player.read");
    if (identity === null) return reply;
    const params = parseTransport(PlayerParamsSchema, request.params);
    const query = parseTransport(PlayerGetTransportSchema, request.query);
    return dependencies.readFacade.getPlayer(
      trustedRequestContext(identity, request),
      params.playerId,
      query,
    );
  });

  server.options("/admin/v1/operations/prepare", async (request, reply) => {
    if (request.headers.origin !== dependencies.allowedOrigin) {
      throw new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Origin denied");
    }
    reply.header("access-control-allow-methods", "POST");
    reply.header("access-control-allow-headers", CONTROL_CENTER_MUTATION_ALLOW_HEADERS);
    reply.header("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    return reply.code(204).send();
  });

  server.post("/admin/v1/operations/prepare", async (request, reply) => {
    if (dependencies.privilegedAuthenticator === undefined) {
      throw new AdminUnauthenticatedError("Privileged administrative authentication required");
    }
    const identity = await authenticateAndLimit(
      request,
      reply,
      dependencies,
      "mutation.prepare",
      dependencies.privilegedAuthenticator,
    );
    if (identity === null) return reply;
    const prepared = await dependencies.mutationFacade.prepareMutation(
      trustedRequestContext(identity, request),
      request.body,
    );
    return projectPreparedOperation(prepared);
  });

  return server;
}
