import type { ExternalIdentity } from "../player/contracts.js";
import type {
  PlayerPortalEncounterCreateInput,
  PlayerPortalEncounterMutationInput,
  PlayerPortalEncounterService,
} from "./encounter-service.js";
import type { HubLoginTicketService } from "./login-ticket-service.js";
import type { PlayerPortalReadService } from "./read-service.js";
import type { HubSessionTokenService } from "./session-token-service.js";
import type { AppError, Result } from "../../shared-kernel/result.js";

const SESSION_COOKIE_NAME = "__Host-pokemon_hub_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const ENCOUNTER_ROUTE_PATTERN = /^\/v1\/hub\/encounters\/([^/]+)(?:\/(observe|engage|flee))?$/;

interface PlayerPortalWorldTravelInput {
  readonly destinationAreaId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
}

interface PlayerPortalWorldBoundary {
  getLocation(identity: ExternalIdentity): Promise<Result<unknown>>;
  travel(identity: ExternalIdentity, input: PlayerPortalWorldTravelInput): Promise<Result<unknown>>;
}

type PlayerPortalEncounterBoundary = Pick<
  PlayerPortalEncounterService,
  "create" | "get" | "observe" | "engage" | "flee"
>;

interface PlayerPortalHttpDependencies {
  readonly tickets: Pick<HubLoginTicketService, "redeem">;
  readonly sessions: Pick<HubSessionTokenService, "issue" | "verify">;
  readonly player: Pick<PlayerPortalReadService, "getSelf" | "getPokemon">;
  readonly world: PlayerPortalWorldBoundary;
  readonly encounter: PlayerPortalEncounterBoundary;
}

interface EncounterRoute {
  readonly encounterId: string;
  readonly action: "observe" | "engage" | "flee" | null;
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
    if (request.method === "GET" && url.pathname === "/v1/hub/player/pokemon") {
      return this.getPokemon(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/world/location") {
      return this.getWorldLocation(request);
    }
    if (request.method === "POST" && url.pathname === "/v1/hub/world/travel") {
      return this.travelWorld(request);
    }
    if (request.method === "POST" && url.pathname === "/v1/hub/encounters") {
      return this.createEncounter(request);
    }

    const encounterRoute = parseEncounterRoute(url.pathname);
    if (encounterRoute !== null) {
      if (request.method === "GET" && encounterRoute.action === null) {
        return this.getEncounter(request, encounterRoute.encounterId);
      }
      if (request.method === "POST" && encounterRoute.action !== null) {
        return this.mutateEncounter(request, encounterRoute);
      }
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
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const profile = await this.dependencies.player.getSelf(verified.value);
    if (!profile.ok) {
      return errorResponse(profile.error, "self");
    }

    return jsonResponse(200, { profile: profile.value });
  }

  private async getPokemon(request: Request): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const pokemon = await this.dependencies.player.getPokemon(verified.value);
    if (!pokemon.ok) {
      return errorResponse(pokemon.error, "self");
    }

    return jsonResponse(200, { pokemon: pokemon.value });
  }

  private async getWorldLocation(request: Request): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const location = await this.dependencies.world.getLocation(verified.value);
    if (!location.ok) {
      return errorResponse(location.error, "self");
    }

    return jsonResponse(200, { location: location.value });
  }

  private async travelWorld(request: Request): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const input = await readWorldTravelInput(request);
    if (input === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const traveled = await this.dependencies.world.travel(verified.value, input);
    if (!traveled.ok) {
      return errorResponse(traveled.error, "self");
    }

    return jsonResponse(200, { travel: traveled.value });
  }

  private async createEncounter(request: Request): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const input = await readEncounterCreateInput(request);
    if (input === null) return jsonResponse(400, { error: "VALIDATION_FAILED" });

    const encounter = await this.dependencies.encounter.create(verified.value, input);
    if (!encounter.ok) return errorResponse(encounter.error, "encounter");
    return jsonResponse(200, { encounter: encounter.value });
  }

  private async getEncounter(request: Request, encounterId: string): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });

    const encounter = await this.dependencies.encounter.get(verified.value, encounterId);
    if (!encounter.ok) return errorResponse(encounter.error, "encounter");
    return jsonResponse(200, { encounter: encounter.value });
  }

  private async mutateEncounter(request: Request, route: EncounterRoute): Promise<Response> {
    const verified = this.verifySession(request);
    if (!verified.ok) return jsonResponse(401, { error: "UNAUTHENTICATED" });
    if (route.action === null) return jsonResponse(404, { error: "NOT_FOUND" });

    const expectedRevision = await readEncounterRevision(request);
    if (expectedRevision === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const input: PlayerPortalEncounterMutationInput = {
      encounterId: route.encounterId,
      expectedRevision,
    };
    const encounter = await this.dependencies.encounter[route.action](verified.value, input);
    if (!encounter.ok) return errorResponse(encounter.error, "encounter");
    return jsonResponse(200, { encounter: encounter.value });
  }

  private verifySession(request: Request): Result<ExternalIdentity> {
    const sessionToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
    if (sessionToken === null) {
      return { ok: false, error: { code: "NOT_FOUND", message: "Hub session unavailable" } };
    }
    return this.dependencies.sessions.verify(sessionToken);
  }
}

function parseEncounterRoute(pathname: string): EncounterRoute | null {
  const match = ENCOUNTER_ROUTE_PATTERN.exec(pathname);
  if (match === null) return null;
  const encounterId = match[1];
  if (encounterId === undefined) return null;
  const action = match[2];
  if (action === "observe" || action === "engage" || action === "flee") {
    return { encounterId, action };
  }
  return { encounterId, action: null };
}

async function readTicket(request: Request): Promise<string | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const ticket = Reflect.get(body, "ticket");
  return typeof ticket === "string" ? ticket : null;
}

async function readWorldTravelInput(
  request: Request,
): Promise<PlayerPortalWorldTravelInput | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;

  const destinationAreaId = Reflect.get(body, "destinationAreaId");
  const expectedRevision = Reflect.get(body, "expectedRevision");
  const idempotencyKey = Reflect.get(body, "idempotencyKey");
  if (
    typeof destinationAreaId !== "string" ||
    typeof expectedRevision !== "string" ||
    typeof idempotencyKey !== "string"
  ) {
    return null;
  }

  return { destinationAreaId, expectedRevision, idempotencyKey };
}

async function readEncounterCreateInput(
  request: Request,
): Promise<PlayerPortalEncounterCreateInput | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;

  const idempotencyKey = Reflect.get(body, "idempotencyKey");
  const encounterTableSlug = Reflect.get(body, "encounterTableSlug");
  if (typeof idempotencyKey !== "string") return null;
  if (encounterTableSlug !== undefined && typeof encounterTableSlug !== "string") return null;

  return encounterTableSlug === undefined
    ? { idempotencyKey }
    : { idempotencyKey, encounterTableSlug };
}

async function readEncounterRevision(request: Request): Promise<string | null> {
  const body = await readJsonObject(request);
  if (body === null) return null;
  const expectedRevision = Reflect.get(body, "expectedRevision");
  return typeof expectedRevision === "string" ? expectedRevision : null;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return null;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
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

function errorResponse(error: AppError, context: "exchange" | "self" | "encounter"): Response {
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
  if (context === "encounter") {
    if (
      error.code === "VALIDATION_FAILED" ||
      error.code === "INVALID_ID" ||
      error.code === "IDEMPOTENCY_KEY_INVALID"
    ) {
      return jsonResponse(400, { error: error.code });
    }
    if (error.code === "NOT_FOUND") return jsonResponse(404, { error: error.code });
    if (
      error.code === "REVISION_CONFLICT" ||
      error.code === "INVALID_STATE_TRANSITION" ||
      error.code === "ACTION_INVALID" ||
      error.code === "FLOW_BLOCKED" ||
      error.code === "FINGERPRINT_MISMATCH"
    ) {
      return jsonResponse(409, { error: error.code });
    }
    if (error.code === "FEATURE_UNAVAILABLE") return jsonResponse(503, { error: error.code });
    if (error.code === "RATE_LIMITED") return jsonResponse(429, { error: error.code });
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
