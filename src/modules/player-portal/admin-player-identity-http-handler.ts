import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import type { AdminPlayerIdentityService } from "../admin/player-identity-service.js";
import type { AdminTeamService } from "../admin/team-service.js";
import type { ExternalIdentity } from "../player/contracts.js";
import { AdminPlayerWhatsAppIdentityChangeRequestSchema } from "./admin-player-identity-contracts.js";
import type { HubSessionTokenService } from "./session-token-service.js";

const SESSION_COOKIE_NAME = "__Host-pokemon_hub_session";

interface AdminIdentityAccess {
  resolvePrincipal(identity: ExternalIdentity): Promise<{ readonly principalId: string } | null>;
  capabilitiesFor(identity: ExternalIdentity): Promise<readonly string[]>;
}

interface AdminPlayerIdentityHttpDependencies {
  readonly sessions: Pick<HubSessionTokenService, "verify">;
  readonly admin: AdminIdentityAccess;
  readonly adminTeam: Pick<AdminTeamService, "isOwner">;
  readonly identity: Pick<AdminPlayerIdentityService, "changeWhatsApp">;
}

export class AdminPlayerIdentityHttpHandler {
  public constructor(private readonly dependencies: AdminPlayerIdentityHttpDependencies) {}

  public async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const playerId = adminPlayerWhatsAppIdentityIdFromPath(url.pathname);
    if (playerId === null) return null;
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
    }

    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
    if (token === null) return jsonResponse(401, { error: "UNAUTHENTICATED" });
    const verified = this.dependencies.sessions.verify(token);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const principal = await this.dependencies.admin.resolvePrincipal(verified.value);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const capabilities = await this.dependencies.admin.capabilitiesFor(verified.value);
    if (
      !capabilities.includes("central.view") ||
      !capabilities.includes("player.identity.change")
    ) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    if (!(await this.dependencies.adminTeam.isOwner(principal.principalId))) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }

    const body = await readJsonBody(request);
    const parsed = AdminPlayerWhatsAppIdentityChangeRequestSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });

    try {
      const changed = await this.dependencies.identity.changeWhatsApp({
        principalId: principal.principalId,
        playerId,
        newWhatsApp: parsed.data.newWhatsApp,
        reason: parsed.data.reason,
        expectedRevision: parsed.data.expectedRevision,
        requestId: parsed.data.requestId,
      });
      return jsonResponse(200, {
        operationId: changed.operation.id,
        status: changed.operation.status,
        replayed: changed.replayed,
        result: changed.operation.result,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }
}

function adminPlayerWhatsAppIdentityIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/whatsapp-identity$/i,
  );
  return match?.[1] ?? null;
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function adminErrorResponse(error: unknown): Response {
  if (!(error instanceof AdminError)) return jsonResponse(500, { error: "INTERNAL_ERROR" });
  if (error.code === ADMIN_ERROR_CODES.INVALID_INPUT) {
    return jsonResponse(400, { error: error.code });
  }
  if (
    error.code === ADMIN_ERROR_CODES.PRINCIPAL_NOT_FOUND ||
    error.code === ADMIN_ERROR_CODES.PRINCIPAL_DISABLED ||
    error.code === ADMIN_ERROR_CODES.AUTHORIZATION_DENIED
  ) {
    return jsonResponse(403, { error: "FORBIDDEN" });
  }
  if (error.code === ADMIN_ERROR_CODES.TARGET_NOT_FOUND) {
    return jsonResponse(404, { error: error.code });
  }
  return jsonResponse(409, { error: error.code });
}

function jsonResponse(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
