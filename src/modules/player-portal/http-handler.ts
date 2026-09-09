import type { ExternalIdentity } from "../player/contracts.js";
import type { HubLoginTicketService } from "./login-ticket-service.js";
import type { PlayerPortalReadService } from "./read-service.js";
import type { HubSessionTokenService } from "./session-token-service.js";
import type { AppError, Result } from "../../shared-kernel/result.js";

const SESSION_COOKIE_NAME = "__Host-pokemon_hub_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

interface PlayerPortalHttpDependencies {
  readonly tickets: Pick<HubLoginTicketService, "redeem">;
  readonly sessions: Pick<HubSessionTokenService, "issue" | "verify">;
  readonly player: Pick<PlayerPortalReadService, "getSelf">;
}

export class PlayerPortalHttpHandler {
  public constructor(private readonly dependencies: PlayerPortalHttpDependencies) {}

  public async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/v1/hub/auth/exchange") {
      return this.exchangeTicket(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/self") {
      return this.getSelf(request);
    }

    return jsonResponse(404, { error: "NOT_FOUND" });
  }

  private async exchangeTicket(request: Request): Promise<Response> {
    const ticket = await readTicket(request);
    if (ticket === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const redeemed = await this.dependencies.tickets.redeem(ticket);
    if (!redeemed.ok) {
      return errorResponse(redeemed.error, "exchange");
    }

    const profile = await this.dependencies.player.getSelf(redeemed.value);
    if (!profile.ok) {
      return errorResponse(profile.error, "exchange");
    }

    const session = this.dependencies.sessions.issue(redeemed.value);
    if (!session.ok) {
      return errorResponse(session.error, "exchange");
    }

    return jsonResponse(
      200,
      {
        profile: profile.value,
        sessionExpiresAt: session.value.expiresAt.toISOString(),
      },
      {
        "set-cookie": serializeSessionCookie(session.value.token),
      },
    );
  }

  private async getSelf(request: Request): Promise<Response> {
    const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
    if (sessionToken === null) {
      return jsonResponse(401, { error: "UNAUTHENTICATED" });
    }

    const verified = this.dependencies.sessions.verify(sessionToken);
    if (!verified.ok) {
      return jsonResponse(401, { error: "UNAUTHENTICATED" });
    }

    const profile = await this.dependencies.player.getSelf(verified.value);
    if (!profile.ok) {
      return errorResponse(profile.error, "self");
    }

    return jsonResponse(200, { profile: profile.value });
  }
}

async function readTicket(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return null;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const ticket = Reflect.get(body, "ticket");
  return typeof ticket === "string" ? ticket : null;
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

function serializeSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function errorResponse(error: AppError, context: "exchange" | "self"): Response {
  if (error.code === "PLAYER_INELIGIBLE") {
    return jsonResponse(403, { error: error.code });
  }
  if (context === "exchange" && error.code === "VALIDATION_FAILED") {
    return jsonResponse(400, { error: error.code });
  }
  if (context === "exchange" && error.code === "NOT_FOUND") {
    return jsonResponse(401, { error: "UNAUTHENTICATED" });
  }
  if (context === "self" && error.code === "NOT_FOUND") {
    return jsonResponse(401, { error: "UNAUTHENTICATED" });
  }

  return jsonResponse(500, { error: "INTERNAL_ERROR" });
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

export type PlayerPortalHttpResult<T> = Result<T>;
export type PlayerPortalHttpIdentity = ExternalIdentity;
