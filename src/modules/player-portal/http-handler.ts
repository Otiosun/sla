import type { AppError } from "../../shared-kernel/result.js";
import type { ExternalIdentity } from "../player/contracts.js";
import type { HubLoginTicketService } from "./login-ticket-service.js";
import type { PlayerPortalMoveChoiceService } from "./move-choice-service.js";
import type { PlayerPortalReadService } from "./read-service.js";
import type { PlayerPortalRosterService } from "./roster-service.js";
import type { HubSessionTokenService } from "./session-token-service.js";

const SESSION_COOKIE_NAME = "__Host-pokemon_hub_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

interface PlayerPortalHttpDependencies {
  readonly tickets: Pick<HubLoginTicketService, "redeem">;
  readonly sessions: Pick<HubSessionTokenService, "issue" | "verify">;
  readonly player: Pick<
    PlayerPortalReadService,
    "getSelf" | "getPokemon" | "getPokedex" | "getInventory" | "getLocation" | "getBattle"
  >;
  readonly roster: Pick<PlayerPortalRosterService, "move">;
  readonly moveChoices: Pick<PlayerPortalMoveChoiceService, "list" | "resolve">;
}

export class PlayerPortalHttpHandler {
  public constructor(private readonly dependencies: PlayerPortalHttpDependencies) {}

  public async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/v1/hub/auth/exchange") {
      return this.exchangeTicket(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/self") {
      return this.withSession(request, (identity) => this.getSelf(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/pokemon") {
      return this.withSession(request, (identity) => this.getPokemon(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/pokedex") {
      return this.withSession(request, (identity) => this.getPokedex(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/inventory") {
      return this.withSession(request, (identity) => this.getInventory(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/battle") {
      return this.withSession(request, (identity) => this.getBattle(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/move-choices") {
      return this.withSession(request, (identity) => this.getMoveChoices(identity));
    }
    if (request.method === "POST" && url.pathname === "/v1/hub/player/move-choices/resolve") {
      return this.withSession(request, (identity) => this.resolveMoveChoice(request, identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/world/location") {
      return this.withSession(request, (identity) => this.getLocation(identity));
    }
    if (request.method === "PUT" && url.pathname === "/v1/hub/player/roster") {
      return this.withSession(request, (identity) => this.moveRoster(request, identity));
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
      return errorResponse(profile.error, "read");
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

  private async withSession(
    request: Request,
    work: (identity: ExternalIdentity) => Promise<Response>,
  ): Promise<Response> {
    const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
    if (sessionToken === null) {
      return jsonResponse(401, { error: "UNAUTHENTICATED" });
    }

    const verified = this.dependencies.sessions.verify(sessionToken);
    if (!verified.ok) {
      return jsonResponse(401, { error: "UNAUTHENTICATED" });
    }
    return work(verified.value);
  }

  private async getSelf(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getSelf(identity);
    return result.ok
      ? jsonResponse(200, { profile: result.value })
      : errorResponse(result.error, "read");
  }

  private async getPokemon(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getPokemon(identity);
    return result.ok
      ? jsonResponse(200, { pokemon: result.value })
      : errorResponse(result.error, "read");
  }

  private async getPokedex(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getPokedex(identity);
    return result.ok
      ? jsonResponse(200, { pokedex: result.value })
      : errorResponse(result.error, "read");
  }

  private async getInventory(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getInventory(identity);
    return result.ok
      ? jsonResponse(200, { inventory: result.value })
      : errorResponse(result.error, "read");
  }

  private async getLocation(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getLocation(identity);
    return result.ok
      ? jsonResponse(200, { location: result.value })
      : errorResponse(result.error, "read");
  }

  private async getBattle(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.player.getBattle(identity);
    return result.ok
      ? jsonResponse(200, { battle: result.value })
      : errorResponse(result.error, "read");
  }

  private async getMoveChoices(identity: ExternalIdentity): Promise<Response> {
    const result = await this.dependencies.moveChoices.list(identity);
    return result.ok
      ? jsonResponse(200, result.value)
      : errorResponse(result.error, "moves");
  }

  private async resolveMoveChoice(request: Request, identity: ExternalIdentity): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const result = await this.dependencies.moveChoices.resolve(identity, body);
    if (!result.ok) {
      return errorResponse(result.error, "moves");
    }

    const refreshed = await this.dependencies.moveChoices.list(identity);
    if (!refreshed.ok) {
      return errorResponse(refreshed.error, "moves");
    }

    return jsonResponse(200, {
      result: result.value,
      blockedByBattle: refreshed.value.blockedByBattle,
      choices: refreshed.value.choices,
    });
  }

  private async moveRoster(request: Request, identity: ExternalIdentity): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const moved = await this.dependencies.roster.move(identity, body);
    if (!moved.ok) {
      return errorResponse(moved.error, "roster");
    }

    const pokemon = await this.dependencies.player.getPokemon(identity);
    if (!pokemon.ok) {
      return errorResponse(pokemon.error, "read");
    }

    return jsonResponse(200, { pokemon: pokemon.value });
  }
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

async function readTicket(request: Request): Promise<string | null> {
  const body = await readJsonBody(request);
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

function errorResponse(
  error: AppError,
  context: "exchange" | "read" | "roster" | "moves",
): Response {
  if (error.code === "PLAYER_INELIGIBLE") {
    return jsonResponse(403, { error: error.code });
  }
  if (error.code === "FEATURE_UNAVAILABLE") {
    return jsonResponse(503, { error: error.code });
  }
  if (error.code === "VALIDATION_FAILED") {
    return jsonResponse(400, { error: error.code });
  }
  if (context === "exchange" && error.code === "NOT_FOUND") {
    return jsonResponse(401, { error: "UNAUTHENTICATED" });
  }
  if (context === "read" && error.code === "NOT_FOUND") {
    return jsonResponse(401, { error: "UNAUTHENTICATED" });
  }
  if (context === "roster" && error.code === "NOT_FOUND") {
    return jsonResponse(404, { error: error.code });
  }
  if (context === "roster" && error.code === "ACTION_INVALID") {
    return jsonResponse(409, { error: error.code });
  }
  if (context === "moves" && error.code === "NOT_FOUND") {
    return jsonResponse(404, { error: error.code });
  }
  if (
    context === "moves" &&
    (error.code === "ACTION_INVALID" || error.code === "FLOW_BLOCKED")
  ) {
    return jsonResponse(409, { error: error.code });
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
