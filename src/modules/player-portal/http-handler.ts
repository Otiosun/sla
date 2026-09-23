import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import type { Player360Service } from "../admin/player360-service.js";
import { AdminPlayerAdjustmentRequestSchema } from "./admin-player-adjustment-contracts.js";
import {
  AdminOperationApprovalRequestSchema,
  AdminOperationPrepareRequestSchema,
} from "./admin-operation-contracts.js";
import type { AppError } from "../../shared-kernel/result.js";
import type { ExternalIdentity } from "../player/contracts.js";
import type { HubLoginTicketService } from "./login-ticket-service.js";
import type { PlayerPortalMoveChoiceService } from "./move-choice-service.js";
import type { PlayerPortalProfileCustomizationService } from "./profile-customization-service.js";
import type { PlayerPortalReadService } from "./read-service.js";
import type { PlayerPortalRosterService } from "./roster-service.js";
import type { HubSessionTokenService } from "./session-token-service.js";

const SESSION_COOKIE_NAME = "__Host-pokemon_hub_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

interface PlayerPortalAdminAccess {
  resolvePrincipal(identity: ExternalIdentity): Promise<{ readonly principalId: string } | null>;
  capabilitiesFor(identity: ExternalIdentity): Promise<readonly string[]>;
}

interface PlayerPortalAdminOperationPolicy {
  readonly version: number;
  readonly requiresReason: boolean;
  readonly requiresExpectedRevision: boolean;
  readonly requiresSimulation: boolean;
  readonly requiresConfirmation: boolean;
  readonly requiredApprovals: number;
}

interface PlayerPortalAdminOperationDefinition {
  readonly kind: "READ" | "MUTATION";
  readonly operationType: string;
  readonly capabilityKey: string;
  readonly riskTier: number;
  readonly authorizationMode: "GLOBAL_ONLY" | "SUBJECT";
  readonly policy: PlayerPortalAdminOperationPolicy;
}

interface PlayerPortalAdminOperationResult {
  readonly id: string;
  readonly status: string;
  readonly result: Readonly<Record<string, unknown>> | null;
}

interface PlayerPortalAdminMutationAccess {
  listOperationDefinitions(): readonly PlayerPortalAdminOperationDefinition[];
  prepareMutation(request: unknown): Promise<{
    readonly operation: PlayerPortalAdminOperationResult;
    readonly replayed: boolean;
  }>;
  simulate(operationId: string, actorPrincipalId: string): Promise<PlayerPortalAdminOperationResult>;
  confirm(operationId: string, actorPrincipalId: string): Promise<PlayerPortalAdminOperationResult>;
  approve(
    operationId: string,
    actorPrincipalId: string,
    reason: string,
  ): Promise<PlayerPortalAdminOperationResult>;
  apply(operationId: string, actorPrincipalId: string): Promise<PlayerPortalAdminOperationResult>;
}

interface PlayerPortalHttpDependencies {
  readonly tickets: Pick<HubLoginTicketService, "redeem">;
  readonly sessions: Pick<HubSessionTokenService, "issue" | "verify">;
  readonly player: Pick<
    PlayerPortalReadService,
    "getSelf" | "getPokemon" | "getPokedex" | "getInventory" | "getLocation" | "getBattle"
  >;
  readonly roster: Pick<PlayerPortalRosterService, "move">;
  readonly moveChoices: Pick<PlayerPortalMoveChoiceService, "list" | "resolve">;
  readonly customization: Pick<PlayerPortalProfileCustomizationService, "update">;
  readonly admin: PlayerPortalAdminAccess;
  readonly adminPlayers: Pick<Player360Service, "search" | "get">;
  readonly adminMutations: PlayerPortalAdminMutationAccess;
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
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/self") {
      return this.withSession(request, (identity) => this.getAdminSelf(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/players") {
      return this.withSession(request, (identity) => this.searchAdminPlayers(url, identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/operations") {
      return this.withSession(request, (identity) => this.listAdminOperations(identity));
    }
    if (request.method === "POST" && url.pathname === "/v1/hub/admin/operations") {
      return this.withSession(request, (identity) => this.prepareAdminOperation(request, identity));
    }
    const adminOperationAction = adminOperationActionFromPath(url.pathname);
    if (request.method === "POST" && adminOperationAction !== null) {
      return this.withSession(request, (identity) =>
        this.advanceAdminOperation(request, adminOperationAction, identity),
      );
    }
    const adminAdjustmentPlayerId = adminPlayerAdjustmentIdFromPath(url.pathname);
    if (request.method === "POST" && adminAdjustmentPlayerId !== null) {
      return this.withSession(request, (identity) =>
        this.adjustAdminPlayer(request, adminAdjustmentPlayerId, identity),
      );
    }
    const adminPlayerId = adminPlayerIdFromPath(url.pathname);
    if (request.method === "GET" && adminPlayerId !== null) {
      return this.withSession(request, (identity) => this.getAdminPlayer(adminPlayerId, identity));
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
    if (
      request.method === "GET" &&
      (url.pathname === "/v1/hub/world/location" || url.pathname === "/v1/hub/player/location")
    ) {
      return this.withSession(request, (identity) => this.getLocation(identity));
    }
    if (request.method === "PUT" && url.pathname === "/v1/hub/player/roster") {
      return this.withSession(request, (identity) => this.moveRoster(request, identity));
    }
    if (request.method === "PUT" && url.pathname === "/v1/hub/player/profile-customization") {
      return this.withSession(request, (identity) =>
        this.updateProfileCustomization(request, identity),
      );
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

  private async getAdminSelf(identity: ExternalIdentity): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) {
      return jsonResponse(200, { admin: null });
    }

    const capabilities = await this.dependencies.admin.capabilitiesFor(identity);
    return jsonResponse(200, {
      admin: {
        principalId: principal.principalId,
        capabilities: [...capabilities],
      },
    });
  }

  private async listAdminOperations(identity: ExternalIdentity): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const capabilities = new Set(await this.dependencies.admin.capabilitiesFor(identity));
    const operations = this.dependencies.adminMutations
      .listOperationDefinitions()
      .filter((operation) => capabilities.has(operation.capabilityKey))
      .map((operation) => ({
        kind: operation.kind,
        operationType: operation.operationType,
        capabilityKey: operation.capabilityKey,
        riskTier: operation.riskTier,
        authorizationMode: operation.authorizationMode,
        policy: { ...operation.policy },
      }));

    return jsonResponse(200, { operations });
  }

  private async prepareAdminOperation(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const body = await readJsonBody(request);
    const parsed = AdminOperationPrepareRequestSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });

    const data = parsed.data;
    try {
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: principal.principalId,
        operationType: data.operationType,
        input: data.input,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
        ...(data.expectedRevision === undefined
          ? {}
          : { expectedRevision: data.expectedRevision }),
        idempotencyKey: `hub-admin-operation:${data.requestId}`,
        correlationId: data.requestId,
      });
      return jsonResponse(200, {
        operationId: prepared.operation.id,
        status: prepared.operation.status,
        replayed: prepared.replayed,
        result: prepared.operation.result,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async advanceAdminOperation(
    request: Request,
    action: { readonly operationId: string; readonly action: "simulate" | "confirm" | "approve" | "apply" },
    identity: ExternalIdentity,
  ): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    try {
      const operation =
        action.action === "simulate"
          ? await this.dependencies.adminMutations.simulate(
              action.operationId,
              principal.principalId,
            )
          : action.action === "confirm"
            ? await this.dependencies.adminMutations.confirm(
                action.operationId,
                principal.principalId,
              )
            : action.action === "approve"
              ? await this.approveAdminOperation(request, action.operationId, principal.principalId)
              : await this.dependencies.adminMutations.apply(
                  action.operationId,
                  principal.principalId,
                );

      return jsonResponse(200, {
        operationId: operation.id,
        status: operation.status,
        result: operation.result,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async approveAdminOperation(
    request: Request,
    operationId: string,
    principalId: string,
  ): Promise<PlayerPortalAdminOperationResult> {
    const body = await readJsonBody(request);
    const parsed = AdminOperationApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AdminError(ADMIN_ERROR_CODES.INVALID_INPUT, "Invalid approval request");
    }
    return this.dependencies.adminMutations.approve(operationId, principalId, parsed.data.reason);
  }

  private async searchAdminPlayers(url: URL, identity: ExternalIdentity): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw === null || limitRaw.trim() === "" ? undefined : Number.parseInt(limitRaw, 10);
    const request = {
      principalId: principal.principalId,
      includeSensitive: false,
      ...(url.searchParams.get("q")?.trim()
        ? { trainerNamePrefix: url.searchParams.get("q")?.trim() }
        : {}),
      ...(url.searchParams.get("status")?.trim()
        ? { status: url.searchParams.get("status")?.trim() }
        : {}),
      ...(url.searchParams.get("cursor")?.trim()
        ? { cursor: url.searchParams.get("cursor")?.trim() }
        : {}),
      ...(limit === undefined ? {} : { limit }),
    };

    try {
      const result = await this.dependencies.adminPlayers.search(request);
      return jsonResponse(200, { players: result.items, nextCursor: result.nextCursor });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async getAdminPlayer(playerId: string, identity: ExternalIdentity): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    try {
      const player = await this.dependencies.adminPlayers.get({
        principalId: principal.principalId,
        playerId,
        includeSensitive: false,
      });
      return jsonResponse(200, { player });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async adjustAdminPlayer(
    request: Request,
    playerId: string,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const body = await readJsonBody(request);
    const parsed = AdminPlayerAdjustmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const data = parsed.data;
    const operation =
      data.kind === "INVENTORY"
        ? {
            operationType: "inventory.adjust",
            input: { playerId, itemId: data.itemId, delta: data.delta },
          }
        : data.kind === "WALLET"
          ? {
              operationType: "wallet.adjust",
              input: { playerId, currencyId: data.currencyId, delta: data.delta },
            }
          : {
              operationType: "progression.trainer.adjust",
              input: { playerId, delta: data.delta },
            };

    try {
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: principal.principalId,
        operationType: operation.operationType,
        input: operation.input,
        reason: data.reason,
        idempotencyKey: `hub-player-adjust:${data.requestId}`,
        correlationId: data.requestId,
      });
      const applied = await this.dependencies.adminMutations.apply(
        prepared.operation.id,
        principal.principalId,
      );
      return jsonResponse(200, {
        operationId: applied.id,
        status: applied.status,
        replayed: prepared.replayed,
        result: applied.result,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
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
      ? jsonResponse(200, {
          blockedByBattle: result.value.blockedByBattle,
          choices: result.value.choices,
        })
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

  private async updateProfileCustomization(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
      return jsonResponse(400, { error: "VALIDATION_FAILED" });
    }

    const updated = await this.dependencies.customization.update(identity, body);
    if (!updated.ok) {
      return errorResponse(updated.error, "profile");
    }

    const profile = await this.dependencies.player.getSelf(identity);
    if (!profile.ok) {
      return errorResponse(profile.error, "read");
    }

    return jsonResponse(200, { profile: profile.value });
  }
}

function adminOperationActionFromPath(
  pathname: string,
): {
  readonly operationId: string;
  readonly action: "simulate" | "confirm" | "approve" | "apply";
} | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(simulate|confirm|approve|apply)$/i,
  );
  if (match === null) return null;
  const operationId = match[1];
  const action = match[2]?.toLowerCase();
  if (
    operationId === undefined ||
    (action !== "simulate" && action !== "confirm" && action !== "approve" && action !== "apply")
  ) {
    return null;
  }
  return { operationId, action };
}

function adminPlayerAdjustmentIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/adjustments$/i,
  );
  return match?.[1] ?? null;
}

function adminPlayerIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  return match?.[1] ?? null;
}

function adminErrorResponse(error: unknown): Response {
  if (!(error instanceof AdminError)) {
    return jsonResponse(500, { error: "INTERNAL_ERROR" });
  }

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
  context: "exchange" | "read" | "roster" | "moves" | "profile",
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
  if (context === "profile" && error.code === "NOT_FOUND") {
    return jsonResponse(404, { error: error.code });
  }
  if (context === "roster" && error.code === "ACTION_INVALID") {
    return jsonResponse(409, { error: error.code });
  }
  if (context === "moves" && error.code === "NOT_FOUND") {
    return jsonResponse(404, { error: error.code });
  }
  if (context === "moves" && (error.code === "ACTION_INVALID" || error.code === "FLOW_BLOCKED")) {
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
