import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import type { AdminReadFacade } from "./read-facade.js";
import type { AdminRequestAuthenticator } from "./request-authenticator.js";
import type { AdminSessionService } from "./session-service.js";
import { mapAdminHttpError } from "./http-error-mapper.js";

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

export interface AdminApiServerDependencies {
  readonly allowedOrigin: string;
  readonly authenticator: Pick<AdminRequestAuthenticator, "authenticate">;
  readonly sessionService: Pick<AdminSessionService, "getSession">;
  readonly readFacade: Pick<AdminReadFacade, "searchPlayers" | "getPlayer">;
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

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== dependencies.allowedOrigin) {
      const mapped = mapAdminHttpError(
        new AdminError(ADMIN_ERROR_CODES.AUTHORIZATION_DENIED, "Origin denied"),
        correlationId,
      );
      await reply.code(mapped.statusCode).send(mapped.body);
      return reply;
    }
    if (origin === dependencies.allowedOrigin) {
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

  server.get("/admin/v1/session", async (request) => {
    const identity = await dependencies.authenticator.authenticate(accessAssertion(request));
    return dependencies.sessionService.getSession(identity);
  });

  server.get("/admin/v1/players", async (request) => {
    const identity = await dependencies.authenticator.authenticate(accessAssertion(request));
    const query = parseTransport(PlayerSearchTransportSchema, request.query);
    return dependencies.readFacade.searchPlayers(identity, query);
  });

  server.get("/admin/v1/players/:playerId", async (request) => {
    const identity = await dependencies.authenticator.authenticate(accessAssertion(request));
    const params = parseTransport(PlayerParamsSchema, request.params);
    const query = parseTransport(PlayerGetTransportSchema, request.query);
    return dependencies.readFacade.getPlayer(identity, params.playerId, query);
  });

  return server;
}
