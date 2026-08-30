import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdminPreparedOperation } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import { mapAdminHttpError } from "./http-error-mapper.js";
import type { ResolvedAdminIdentityContext } from "./identity-resolver.js";
import type { AdminMutationFacade } from "./mutation-facade.js";
import type { AdminReadFacade } from "./read-facade.js";
import type { AdminRequestAuthenticator } from "./request-authenticator.js";
import type { AdminSessionService } from "./session-service.js";

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

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

const PlayerParamsSchema = z.object({ playerId: z.string().uuid() }).strict();

export type AdminApiRateLimitedOperation =
  | "session.read"
  | "player.search"
  | "player.read"
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
  readonly sessionService: Pick<AdminSessionService, "getSession">;
  readonly readFacade: Pick<AdminReadFacade, "searchPlayers" | "getPlayer">;
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
  return request.method === "POST" && origin !== allowedOrigin;
}

async function authenticateAndLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminApiServerDependencies,
  operation: AdminApiRateLimitedOperation,
): Promise<ResolvedAdminIdentityContext | null> {
  const identity = await dependencies.authenticator.authenticate(accessAssertion(request));
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

  server.get("/admin/v1/players", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "player.search");
    if (identity === null) return reply;
    const query = parseTransport(PlayerSearchTransportSchema, request.query);
    return dependencies.readFacade.searchPlayers(trustedRequestContext(identity, request), query);
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
    reply.header("access-control-allow-headers", "content-type");
    return reply.code(204).send();
  });

  server.post("/admin/v1/operations/prepare", async (request, reply) => {
    const identity = await authenticateAndLimit(request, reply, dependencies, "mutation.prepare");
    if (identity === null) return reply;
    const prepared = await dependencies.mutationFacade.prepareMutation(
      trustedRequestContext(identity, request),
      request.body,
    );
    return projectPreparedOperation(prepared);
  });

  return server;
}
