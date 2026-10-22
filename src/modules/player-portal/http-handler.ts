import { z } from "zod";
import type { EntitlementService } from "../entitlements/service.js";
import type { PremiumOrderService } from "../premium-orders/service.js";
import { PremiumSupportNoteSchema, type PremiumSupportService } from "../premium-support/service.js";
import type { AppError } from "../../shared-kernel/result.js";
import { ManualPremiumDeliverySchema, type ManualPremiumDeliveryService } from "../premium-orders/manual-delivery-service.js";
import {
  type PremiumDeliveryCaseService, OpenPremiumDeliveryCaseSchema, AdvancePremiumDeliveryCaseSchema,
} from "../premium-orders/manual-delivery-case-service.js";
import { ManualPremiumItemDeliverySchema } from "../premium-orders/manual-item-delivery-contracts.js";
import { ManualMasterBallPackSchema, MASTER_BALL_ITEM_SLUG } from "../premium-orders/manual-master-ball-pack-contracts.js";
import { ManualPremiumPokemonDeliverySchema } from "../premium-orders/manual-pokemon-delivery-contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../admin/errors.js";
import type { Player360Service } from "../admin/player360-service.js";
import type { AdminRewardCatalogService } from "../admin/reward-catalog-service.js";
import type { AdminTeamService } from "../admin/team-service.js";
import type { ExternalIdentity } from "../player/contracts.js";
import {
  AdminOperationApprovalRequestSchema,
  AdminOperationPrepareRequestSchema,
} from "./admin-operation-contracts.js";
import { AdminPlayerAdjustmentRequestSchema } from "./admin-player-adjustment-contracts.js";
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

interface PlayerPortalAdminAuditEntry {
  readonly operationId: string;
  readonly operationType: string;
  readonly actorDisplayName: string;
  readonly targetType: string;
  readonly riskTier: number;
  readonly status: string;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

interface PlayerPortalAdminAuditAccess {
  list(principalId: string, limit: number): Promise<readonly PlayerPortalAdminAuditEntry[]>;
}

interface PlayerPortalAdminMutationAccess {
  listOperationDefinitions(): readonly PlayerPortalAdminOperationDefinition[];
  prepareMutation(request: unknown): Promise<{
    readonly operation: PlayerPortalAdminOperationResult;
    readonly replayed: boolean;
  }>;
  simulate(
    operationId: string,
    actorPrincipalId: string,
  ): Promise<PlayerPortalAdminOperationResult>;
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
  readonly adminRewardCatalog: Pick<AdminRewardCatalogService, "get">;
  readonly adminAudit?: PlayerPortalAdminAuditAccess;
  readonly adminTeam?: Pick<
    AdminTeamService,
    "isOwner" | "list" | "addPrincipal" | "setReceptionStaff" | "replaceCapabilities"
  >;
  readonly adminMutations: PlayerPortalAdminMutationAccess;
  /** Only mounted by separately opted-in Premium loopback API. */
  readonly premiumDelivery?: Pick<ManualPremiumDeliveryService, "catalog" | "history" | "deliver">;
  readonly premiumCases?: Pick<PremiumDeliveryCaseService, "catalog" | "list" | "timeline" | "open" | "advance">;
  readonly premiumSupport?: Pick<PremiumSupportService, "list" | "append">;
  readonly premiumRead?: {
    readonly orders: Pick<PremiumOrderService, "listPlayerOrders">;
    readonly entitlements: Pick<EntitlementService, "listPlayerEntitlements">;
  };
}

export class PlayerPortalHttpHandler {
  public constructor(private readonly dependencies: PlayerPortalHttpDependencies) {}

  public async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Browser CSRF cannot bypass the authenticated owner boundary by calling
    // the tunnel directly; the Vercel BFF makes server-side requests without Origin.
    if (request.method === "POST" &&
        url.pathname.startsWith("/v1/hub/admin/premium/") &&
        ((request.headers.get("origin") !== null &&
          request.headers.get("origin") !== url.origin) ||
          request.headers.get("sec-fetch-site") === "cross-site")) {
      return jsonResponse(403, { error: "CROSS_ORIGIN_PREMIUM_MUTATION" });
    }

    if (request.method === "POST" && url.pathname === "/v1/hub/auth/exchange") {
      return this.exchangeTicket(request);
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/self") {
      return this.withSession(request, (identity) => this.getSelf(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/player/benefits" && !url.search) {
      return this.withSession(request, (identity) => this.getOwnBenefits(identity));
    }
    const premiumReadMatch = url.pathname.match(
      /^\/v1\/hub\/admin\/premium\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(orders|entitlements)$/i,
    );
    if (request.method === "GET" && premiumReadMatch?.[1] && !url.search) {
      const resource = premiumReadMatch[2]?.toLowerCase();
      if (resource === "orders" || resource === "entitlements") {
        return this.withSession(request, (identity) =>
          this.getAdminPremiumRead(identity, premiumReadMatch[1]!, resource));
      }
    }

    const premiumSupportMatch = url.pathname.match(
      /^\/v1\/hub\/admin\/premium\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/support$/i,
    );
    if ((request.method === "GET" || request.method === "POST") &&
        premiumSupportMatch?.[1] && !url.search) {
      return this.withSession(request, (identity) =>
        this.adminPremiumSupport(request, identity, premiumSupportMatch[1]!));
    }

    if (url.pathname === "/v1/hub/admin/premium/delivery/cases/catalog" &&
        request.method === "GET" && !url.search) {
      return this.withSession(request, (identity) =>
        this.manualPremiumCase(request, identity, "catalog"),
      );
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery/cases" &&
        ((request.method === "POST" && !url.search) ||
         (request.method === "GET" && url.searchParams.size === 1 && url.searchParams.has("playerId")))) {
      return this.withSession(request, (identity) =>
        this.manualPremiumCase(request, identity, request.method === "POST" ? "open" : "list",
          url.searchParams.get("playerId") ?? undefined),
      );
    }
    const caseMatch=url.pathname.match(
      /^\/v1\/hub\/admin\/premium\/delivery\/cases\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(transition|events)$/i,
    );
    if (caseMatch?.[1] && !url.search &&
        ((caseMatch[2] === "transition" && request.method === "POST") ||
         (caseMatch[2] === "events" && request.method === "GET"))) {
      const caseId=caseMatch[1];
      return this.withSession(request, (identity) =>
        this.manualPremiumCase(request, identity, caseMatch[2] === "events" ? "timeline" : "advance", caseId),
      );
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery/catalog" &&
        request.method === "GET" && !url.search) {
      return this.withSession(request, (identity) =>
        this.manualPremiumDelivery(request, identity, "catalog"),
      );
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery/pokemon" && !url.search &&
        (request.method === "GET" || request.method === "POST")) {
      return this.withSession(request, (identity) =>
        this.manualPremiumPokemonDelivery(request, identity),
      );
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery/packs/master" &&
        (request.method === "GET" || request.method === "POST") && !url.search) {
      return this.withSession(request, (identity) =>
        this.manualMasterBallPackDelivery(request, identity),
      );
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery/items" && !url.search &&
        (request.method === "GET" || request.method === "POST")) {
      return this.withSession(request, (identity) => this.manualPremiumItemDelivery(request, identity));
    }
    if (url.pathname === "/v1/hub/admin/premium/delivery" &&
        request.method === "POST" && !url.search) {
      return this.withSession(request, (identity) =>
        this.manualPremiumDelivery(request, identity, "deliver"),
      );
    }
    const manualHistory = url.pathname.match(
      /^\/v1\/hub\/admin\/premium\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/deliveries$/i,
    );
    if (request.method === "GET" && manualHistory?.[1] && !url.search) {
      return this.withSession(request, (identity) =>
        this.manualPremiumDelivery(request, identity, "history", manualHistory[1]),
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/self") {
      return this.withSession(request, (identity) => this.getAdminSelf(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/players") {
      return this.withSession(request, (identity) => this.searchAdminPlayers(url, identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/audit") {
      return this.withSession(request, (identity) => this.listAdminAudit(url, identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/operations") {
      return this.withSession(request, (identity) => this.listAdminOperations(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/reward-catalog") {
      return this.withSession(request, (identity) => this.getAdminRewardCatalog(identity));
    }
    if (request.method === "GET" && url.pathname === "/v1/hub/admin/team") {
      return this.withSession(request, (identity) => this.getAdminTeam(identity));
    }
    if (request.method === "POST" && url.pathname === "/v1/hub/admin/team") {
      return this.withSession(request, (identity) => this.addAdminTeamPrincipal(request, identity));
    }
    const adminTeamTarget = adminTeamCapabilityTargetFromPath(url.pathname);
    if (request.method === "PUT" && adminTeamTarget !== null) {
      return this.withSession(request, (identity) =>
        this.replaceAdminTeamCapabilities(request, adminTeamTarget, identity),
      );
    }
    const receptionStaffTarget = adminTeamReceptionStaffTargetFromPath(url.pathname);
    if (request.method === "PUT" && receptionStaffTarget !== null) {
      return this.withSession(request, (identity) =>
        this.setAdminTeamReceptionStaff(request, receptionStaffTarget, identity),
      );
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

  /** Only the player bound to the verified Hub cookie may read their own entitlements. */
  private async getOwnBenefits(identity: ExternalIdentity): Promise<Response> {
    const self = await this.dependencies.player.getSelf(identity);
    if (!self.ok) return errorResponse(self.error, "read");

    const entitlements = this.dependencies.premiumRead?.entitlements;
    if (!entitlements) return jsonResponse(503, { error: "BENEFITS_UNAVAILABLE" });

    try {
      return jsonResponse(200, {
        entitlements: await entitlements.listPlayerEntitlements(self.value.playerId),
      });
    } catch {
      return jsonResponse(503, { error: "BENEFITS_UNAVAILABLE" });
    }
  }

  private async resolvePortalAdmin(identity: ExternalIdentity): Promise<{
    readonly principalId: string;
    readonly capabilities: readonly string[];
  } | null> {
    const principal = await this.dependencies.admin.resolvePrincipal(identity);
    if (principal === null) return null;
    const capabilities = await this.dependencies.admin.capabilitiesFor(identity);
    if (!capabilities.includes("central.view")) return null;
    return { principalId: principal.principalId, capabilities };
  }

  private async getAdminSelf(identity: ExternalIdentity): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) {
      return jsonResponse(200, { admin: null });
    }
    const owner =
      this.dependencies.adminTeam === undefined
        ? false
        : await this.dependencies.adminTeam.isOwner(admin.principalId);
    return jsonResponse(200, {
      admin: {
        principalId: admin.principalId,
        owner,
        capabilities: [...admin.capabilities],
      },
    });
  }

  private async manualPremiumPokemonDelivery(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    if (!this.dependencies.premiumDelivery) {
      return jsonResponse(503, { error: "PREMIUM_DELIVERY_UNAVAILABLE" });
    }
    try {
      const catalog = await this.dependencies.adminRewardCatalog.get(admin.principalId, {
        items: false,
        currencies: false,
        species: false,
        forms: true,
        effects: false,
        releases: false,
      });
      if (request.method === "GET") {
        return jsonResponse(200, {
          forms: (catalog.forms ?? []).map((entry) => ({
            formId: entry.formId,
            speciesSlug: entry.speciesSlug,
            formSlug: entry.formSlug,
            displayName: entry.displayName,
          })),
        });
      }
      const parsed = ManualPremiumPokemonDeliverySchema.safeParse(await readJsonBody(request));
      if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });
      const input = parsed.data;
      if (!(catalog.forms ?? []).some((entry) => entry.formId === input.formId)) {
        return jsonResponse(404, { error: "POKEMON_FORM_NOT_PUBLISHED" });
      }

      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: admin.principalId,
        operationType: "pokemon.create",
        input: {
          playerId: input.playerId,
          formId: input.formId,
          level: input.level,
          shiny: input.shiny,
        },
        reason: input.reason,
        idempotencyKey: `premium-pokemon:${input.requestId}`,
        correlationId: input.requestId,
      });
      let operation = prepared.operation;
      if (operation.status === "PENDING_CONFIRMATION") {
        operation = await this.dependencies.adminMutations.confirm(
          operation.id,
          admin.principalId,
        );
      }
      if (operation.status === "READY") {
        operation = await this.dependencies.adminMutations.apply(
          operation.id,
          admin.principalId,
        );
      }
      if (operation.status !== "APPLIED") {
        return jsonResponse(409, { error: "POKEMON_DELIVERY_NOT_APPLIED", operationId: operation.id });
      }
      return jsonResponse(prepared.replayed ? 200 : 201, {
        applied: true,
        replayed: prepared.replayed,
        operationId: operation.id,
        requestId: input.requestId,
        playerId: input.playerId,
        formId: input.formId,
        level: input.level,
        shiny: input.shiny,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async manualMasterBallPackDelivery(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    // Production must not gain a delivery API just because normal AdminService exists.
    if (!this.dependencies.premiumDelivery) {
      return jsonResponse(503, { error: "PREMIUM_DELIVERY_UNAVAILABLE" });
    }
    try {
      const catalog = await this.dependencies.adminRewardCatalog.get(admin.principalId, {
        items: true,
        currencies: false,
        species: false,
        forms: false,
        effects: false,
        releases: false,
      });
      const masterBalls = catalog.items.filter((item) => item.slug === MASTER_BALL_ITEM_SLUG);
      // Never fall back to similarly named items, nor guess UUIDs or inject a seed.
      if (request.method === "GET") {
        return jsonResponse(200, {
          sku: "MASTER",
          quantityPerUnit: 1,
          maxQuantity: 20,
          available: masterBalls.length === 1,
          item: masterBalls.length === 1
            ? { itemId: masterBalls[0]!.itemId, displayName: masterBalls[0]!.displayName }
            : null,
        });
      }
      const parsed = ManualMasterBallPackSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });
      if (masterBalls.length !== 1) {
        return jsonResponse(409, { error: "MASTER_BALL_NOT_PUBLISHED" });
      }
      const input = parsed.data;
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: admin.principalId,
        operationType: "inventory.adjust",
        input: {
          playerId: input.playerId,
          itemId: masterBalls[0]!.itemId,
          delta: String(input.quantity),
        },
        reason: input.reason,
        idempotencyKey: `premium-pack:MASTER:${input.requestId}`,
        correlationId: input.requestId,
      });
      const applied = await this.dependencies.adminMutations.apply(
        prepared.operation.id,
        admin.principalId,
      );
      if (applied.status !== "APPLIED") {
        return jsonResponse(409, {
          error: "MASTER_BALL_DELIVERY_NOT_APPLIED",
          operationId: applied.id,
        });
      }
      return jsonResponse(prepared.replayed ? 200 : 201, {
        applied: true,
        replayed: prepared.replayed,
        operationId: applied.id,
        requestId: input.requestId,
        playerId: input.playerId,
        sku: "MASTER",
        itemId: masterBalls[0]!.itemId,
        quantity: input.quantity,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async manualPremiumItemDelivery(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    // Staging feature boundary: this dependency is NEVER mounted in normal/live runtime.
    if (!this.dependencies.premiumDelivery) {
      return jsonResponse(503, { error: "PREMIUM_DELIVERY_UNAVAILABLE" });
    }
    try {
      const catalog = await this.dependencies.adminRewardCatalog.get(admin.principalId, {
        items: true,
        currencies: false,
        species: false,
        forms: false,
        effects: false,
        releases: false,
      });
      if (request.method === "GET") {
        return jsonResponse(200, {
          items: catalog.items.map((item) => ({
            itemId: item.itemId,
            displayName: item.displayName,
            slug: item.slug,
          })),
        });
      }

      const input = ManualPremiumItemDeliverySchema.safeParse(await readJsonBody(request));
      if (!input.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });
      // Only items in the currently published catalog can be granted.
      if (!catalog.items.some((item) => item.itemId === input.data.itemId)) {
        return jsonResponse(404, { error: "ITEM_NOT_PUBLISHED" });
      }
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: admin.principalId,
        operationType: "inventory.adjust",
        input: {
          playerId: input.data.playerId,
          itemId: input.data.itemId,
          delta: String(input.data.quantity),
        },
        reason: input.data.reason,
        idempotencyKey: `premium-item:${input.data.requestId}`,
        correlationId: input.data.requestId,
      });
      const applied = await this.dependencies.adminMutations.apply(
        prepared.operation.id,
        admin.principalId,
      );
      if (applied.status !== "APPLIED") {
        return jsonResponse(409, { error: "DELIVERY_NOT_APPLIED", operationId: applied.id });
      }
      return jsonResponse(prepared.replayed ? 200 : 201, {
        applied: true,
        replayed: prepared.replayed,
        operationId: applied.id,
        requestId: input.data.requestId,
        playerId: input.data.playerId,
        itemId: input.data.itemId,
        quantity: input.data.quantity,
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async manualPremiumCase(
    request: Request, identity: ExternalIdentity,
    action: "catalog" | "list" | "open" | "advance" | "timeline",
    targetId?: string,
  ): Promise<Response> {
    const admin=await this.resolvePortalAdmin(identity);
    if(!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true)
      return jsonResponse(403,{error:"FORBIDDEN"});
    const cases=this.dependencies.premiumCases;
    if(!cases || !this.dependencies.premiumDelivery)
      return jsonResponse(503,{error:"PREMIUM_DELIVERY_UNAVAILABLE"});
    try {
      if(action==="catalog") return jsonResponse(200,{products:cases.catalog()});
      if(action==="list") {
        if(!targetId || !z.string().uuid().safeParse(targetId).success)
          return jsonResponse(400,{error:"VALIDATION_FAILED"});
        return jsonResponse(200,{cases:await cases.list(targetId)});
      }
      if(action==="timeline") {
        if(!targetId) return jsonResponse(400,{error:"VALIDATION_FAILED"});
        return jsonResponse(200,{events:await cases.timeline(targetId)});
      }
      const raw=await readJsonBody(request);
      if(action==="open") {
        const parsed=OpenPremiumDeliveryCaseSchema.safeParse(raw);
        if(!parsed.success) return jsonResponse(400,{error:"VALIDATION_FAILED"});
        const result=await cases.open(parsed.data,admin.principalId);
        if(result.kind!=="APPLIED")
          return jsonResponse(result.kind==="PLAYER_NOT_FOUND"||result.kind==="SKU_UNSUPPORTED" ? 404 : 409,{error:result.kind});
        return jsonResponse(result.replayed?200:201,{replayed:result.replayed,case:result.case});
      }
      const parsed=AdvancePremiumDeliveryCaseSchema.safeParse(raw);
      if(!parsed.success || parsed.data.caseId!==targetId)
        return jsonResponse(400,{error:"VALIDATION_FAILED"});
      const result=await cases.advance(parsed.data,admin.principalId);
      if(result.kind!=="APPLIED")
        return jsonResponse(result.kind==="NOT_FOUND" ? 404 : 409,{error:result.kind});
      return jsonResponse(200,{replayed:result.replayed,case:result.case});
    } catch(error) { return adminErrorResponse(error); }
  }

  private async manualPremiumDelivery(
    request: Request,
    identity: ExternalIdentity,
    operation: "catalog" | "history" | "deliver",
    playerId?: string,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    const service = this.dependencies.premiumDelivery;
    if (!service) return jsonResponse(503, { error: "PREMIUM_DELIVERY_UNAVAILABLE" });
    try {
      if (operation === "catalog") {
        return jsonResponse(200, { products: await service.catalog() });
      }
      if (operation === "history") {
        if (!playerId) return jsonResponse(400, { error: "VALIDATION_FAILED" });
        return jsonResponse(200, { deliveries: await service.history(playerId) });
      }
      const raw = await readJsonBody(request);
      const parsed = ManualPremiumDeliverySchema.safeParse(raw);
      if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });
      const result = await service.deliver(parsed.data, admin.principalId);
      if (result.kind === "APPLIED") {
        return jsonResponse(result.replayed ? 200 : 201, {
          applied: true, replayed: result.replayed,
          entitlement: result.entitlement, requestId: parsed.data.requestId,
        });
      }
      if (result.kind === "PRODUCT_UNAVAILABLE") {
        return jsonResponse(404, { error: result.kind });
      }
      if (result.kind === "PLAYER_NOT_FOUND") {
        return jsonResponse(404, { error: result.kind });
      }
      return jsonResponse(409, { error: result.kind });
    } catch {
      return jsonResponse(503, { error: "PREMIUM_DELIVERY_UNAVAILABLE" });
    }
  }

  private async adminPremiumSupport(
    request: Request,
    identity: ExternalIdentity,
    playerId: string,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (!admin || (await this.dependencies.adminTeam?.isOwner(admin.principalId)) !== true) {
      return jsonResponse(403, { error: "FORBIDDEN" });
    }
    const service = this.dependencies.premiumSupport;
    if (!service) return jsonResponse(503, { error: "SUPPORT_UNAVAILABLE" });
    try {
      if (request.method === "GET") {
        return jsonResponse(200, { events: await service.list(playerId) });
      }
      const body = await readJsonBody(request);
      const parsed = PremiumSupportNoteSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });
      const record = await service.append(playerId, admin.principalId, parsed.data);
      if (!record) return jsonResponse(404, { error: "SUPPORT_TARGET_NOT_FOUND" });
      return jsonResponse(record.replayed ? 200 : 201, record);
    } catch (error) {
      if (error instanceof Error && error.message === "SUPPORT_IDEMPOTENCY_CONFLICT") {
        return jsonResponse(409, { error: "IDEMPOTENCY_CONFLICT" });
      }
      return jsonResponse(503, { error: "SUPPORT_UNAVAILABLE" });
    }
  }

  private async getAdminPremiumRead(
    identity: ExternalIdentity,
    playerId: string,
    resource: "orders" | "entitlements",
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const isOwner = await this.dependencies.adminTeam?.isOwner(admin.principalId);
    if (isOwner !== true) return jsonResponse(403, { error: "FORBIDDEN" });
    const services = this.dependencies.premiumRead;
    if (!services) return jsonResponse(503, { error: "PREMIUM_READ_UNAVAILABLE" });
    try {
      if (resource === "orders") {
        return jsonResponse(200, { orders: await services.orders.listPlayerOrders(playerId) });
      }
      return jsonResponse(200, {
        entitlements: await services.entitlements.listPlayerEntitlements(playerId),
      });
    } catch {
      return jsonResponse(500, { error: "PREMIUM_READ_FAILED" });
    }
  }

  private async getAdminRewardCatalog(identity: ExternalIdentity): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    try {
      const catalog = await this.dependencies.adminRewardCatalog.get(admin.principalId, {
        items: admin.capabilities.includes("inventory.read"),
        currencies: admin.capabilities.includes("economy.read"),
        species: admin.capabilities.includes("pokedex.read"),
        forms: admin.capabilities.includes("pokemon.create"),
        effects: admin.capabilities.includes("pokemon.edit.mechanics"),
        releases:
          admin.capabilities.includes("content.draft.edit") ||
          admin.capabilities.includes("content.validate") ||
          admin.capabilities.includes("content.publish"),
      });
      return jsonResponse(200, {
        items: [...catalog.items],
        currencies: [...catalog.currencies],
        species: [...(catalog.species ?? [])],
        forms: [...(catalog.forms ?? [])],
        abilities: [...(catalog.abilities ?? [])],
        natures: [...(catalog.natures ?? [])],
        effects: [...(catalog.effects ?? [])],
        releases: [...(catalog.releases ?? [])],
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async getAdminTeam(identity: ExternalIdentity): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const adminTeam = this.dependencies.adminTeam;
    if (adminTeam === undefined) return jsonResponse(403, { error: "FORBIDDEN" });
    try {
      const team = await adminTeam.list(admin.principalId);
      return jsonResponse(200, {
        principals: [...team.principals],
        capabilityCatalog: [...team.capabilityCatalog],
      });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async addAdminTeamPrincipal(
    request: Request,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const adminTeam = this.dependencies.adminTeam;
    if (adminTeam === undefined) return jsonResponse(403, { error: "FORBIDDEN" });
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse(400, { error: "VALIDATION_FAILED" });
    try {
      const principal = await adminTeam.addPrincipal(admin.principalId, body);
      return jsonResponse(201, { principal });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async setAdminTeamReceptionStaff(
    request: Request,
    targetPrincipalId: string,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const adminTeam = this.dependencies.adminTeam;
    if (adminTeam === undefined) return jsonResponse(403, { error: "FORBIDDEN" });
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse(400, { error: "VALIDATION_FAILED" });
    try {
      const principal = await adminTeam.setReceptionStaff(
        admin.principalId,
        targetPrincipalId,
        body,
      );
      return jsonResponse(200, { principal });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async replaceAdminTeamCapabilities(
    request: Request,
    targetPrincipalId: string,
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const adminTeam = this.dependencies.adminTeam;
    if (adminTeam === undefined) return jsonResponse(403, { error: "FORBIDDEN" });
    const body = await readJsonBody(request);
    if (body === null) return jsonResponse(400, { error: "VALIDATION_FAILED" });
    try {
      const principal = await adminTeam.replaceCapabilities(
        admin.principalId,
        targetPrincipalId,
        body,
      );
      return jsonResponse(200, { principal });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async listAdminAudit(url: URL, identity: ExternalIdentity): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });
    const audit = this.dependencies.adminAudit;
    if (audit === undefined) return jsonResponse(403, { error: "FORBIDDEN" });

    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    try {
      const entries = await audit.list(admin.principalId, limit);
      return jsonResponse(200, { entries });
    } catch (error) {
      return adminErrorResponse(error);
    }
  }

  private async listAdminOperations(identity: ExternalIdentity): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const capabilities = new Set(admin.capabilities);
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
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const body = await readJsonBody(request);
    const parsed = AdminOperationPrepareRequestSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: "VALIDATION_FAILED" });

    const data = parsed.data;
    try {
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: admin.principalId,
        operationType: data.operationType,
        input: data.input,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
        ...(data.expectedRevision === undefined ? {} : { expectedRevision: data.expectedRevision }),
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
    action: {
      readonly operationId: string;
      readonly action: "simulate" | "confirm" | "approve" | "apply";
    },
    identity: ExternalIdentity,
  ): Promise<Response> {
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    try {
      const operation =
        action.action === "simulate"
          ? await this.dependencies.adminMutations.simulate(action.operationId, admin.principalId)
          : action.action === "confirm"
            ? await this.dependencies.adminMutations.confirm(action.operationId, admin.principalId)
            : action.action === "approve"
              ? await this.approveAdminOperation(request, action.operationId, admin.principalId)
              : await this.dependencies.adminMutations.apply(action.operationId, admin.principalId);

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
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    const limitRaw = url.searchParams.get("limit");
    const limit =
      limitRaw === null || limitRaw.trim() === "" ? undefined : Number.parseInt(limitRaw, 10);
    const request = {
      principalId: admin.principalId,
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
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

    try {
      const player = await this.dependencies.adminPlayers.get({
        principalId: admin.principalId,
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
    const admin = await this.resolvePortalAdmin(identity);
    if (admin === null) return jsonResponse(403, { error: "FORBIDDEN" });

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
          : data.kind === "POKEMON_XP"
            ? {
                operationType: "pokemon.xp.adjust",
                input: {
                  playerId,
                  pokemonInstanceId: data.pokemonInstanceId,
                  delta: data.delta,
                },
              }
            : {
                operationType: "progression.trainer.adjust",
                input: { playerId, delta: data.delta },
              };

    try {
      const prepared = await this.dependencies.adminMutations.prepareMutation({
        principalId: admin.principalId,
        operationType: operation.operationType,
        input: operation.input,
        reason: data.reason,
        idempotencyKey: `hub-player-adjust:${data.requestId}`,
        correlationId: data.requestId,
      });
      const applied = await this.dependencies.adminMutations.apply(
        prepared.operation.id,
        admin.principalId,
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

function adminOperationActionFromPath(pathname: string): {
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

function adminTeamReceptionStaffTargetFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/team\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/reception-staff$/i,
  );
  return match?.[1] ?? null;
}

function adminTeamCapabilityTargetFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/hub\/admin\/team\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/capabilities$/i,
  );
  return match?.[1] ?? null;
}
