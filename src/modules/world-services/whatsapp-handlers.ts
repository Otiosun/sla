import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { WorldServiceKind } from "./contracts.js";
import type { PokemonCenterHealingService } from "./healing-service.js";
import type { MartSaleInventoryReader } from "./mart-sale.js";
import {
  renderCenterConversationMenu,
  renderMartCatalog,
  renderMartSaleList,
  renderPokemonCenterRecovery,
  renderWorldServiceEntry,
  renderWorldServiceExit,
} from "./renderer.js";
import type { WorldServiceSessionService } from "./session-service.js";

const WORLD_SERVICE_POLICY = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
} as const;

export interface WorldServiceWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly sessions: Pick<
    WorldServiceSessionService,
    "openVisit" | "loadActiveSession" | "closeVisit"
  >;
  readonly healing?: Pick<PokemonCenterHealingService, "healTeam">;
  readonly economy?: Pick<MartSaleInventoryReader, "listSellableInventory">;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

interface WorldServicePromptAnchor {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
}

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly handler: Handler) {}

  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.handler(context);
  }
}

function identity(context: MessageHandlerContext): { provider: string; externalId: string } {
  return {
    provider: context.message.provider,
    externalId: context.message.senderRef,
  };
}

async function resolvePlayer(
  dependencies: WorldServiceWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

function textResult(
  context: MessageHandlerContext,
  text: string,
  resultRefId: string,
  prompt: WorldServicePromptAnchor | null = null,
  idempotencySuffix = "",
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_SESSION",
    resultRefId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload:
          prompt === null
            ? { text }
            : {
                text,
                worldServicePrompt: {
                  playerId: prompt.playerId,
                  expectedRevision: prompt.expectedRevision.toString(),
                },
              },
        idempotencyKey: `${context.idempotencyKey}:world-service${idempotencySuffix}`,
      },
    ],
  });
}

function openHandler(
  dependencies: WorldServiceWhatsAppDependencies,
  serviceKind: WorldServiceKind,
): Handler {
  return async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const location = await dependencies.world.getLocation(player.value);
    if (!location.ok) return location;

    const opened = await dependencies.sessions.openVisit({
      playerId: player.value,
      areaId: location.value.areaId,
      serviceKind,
    });
    if (!opened.ok) return opened;

    return textResult(context, renderWorldServiceEntry(serviceKind), opened.value.sessionId, {
      playerId: player.value,
      expectedRevision: opened.value.revision,
    });
  };
}

export function createWorldServiceWhatsAppRoutes(
  dependencies: WorldServiceWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const close: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null) {
      return ok({
        resultRefType: null,
        resultRefId: null,
        outgoing: [],
      });
    }

    const closed = await dependencies.sessions.closeVisit({
      playerId: player.value,
      expectedRevision: active.value.revision,
    });
    if (!closed.ok) return closed;

    return textResult(context, renderWorldServiceExit(), closed.value.sessionId);
  };

  const buy: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(appError("ACTION_INVALID", "Poké Mart visit is not active"));
    }

    return textResult(
      context,
      renderMartCatalog(),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":mart:catalog",
    );
  };

  const sell: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(appError("ACTION_INVALID", "Poké Mart visit is not active"));
    }
    if (dependencies.economy === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Poké Mart sale service is unavailable"));
    }

    const sellable = await dependencies.economy.listSellableInventory(player.value);
    if (!sellable.ok) return sellable;
    const prompt = sellable.value.length === 0 ? null : {
      playerId: player.value,
      expectedRevision: active.value.revision,
    };

    return textResult(
      context,
      renderMartSaleList(sellable.value),
      active.value.sessionId,
      prompt,
      sellable.value.length === 0 ? ":mart:sale:empty" : ":mart:sale:list",
    );
  };

  const heal: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (dependencies.healing === undefined) {
      return err(
        appError("INVALID_STATE_TRANSITION", "Pokémon Center healing service is unavailable"),
      );
    }

    const healed = await dependencies.healing.healTeam({
      playerId: player.value,
      sessionId: active.value.sessionId,
      sourceInboxMessageId: context.inboxMessageId,
      correlationId: context.correlationId,
    });
    if (!healed.ok) return healed;

    return textResult(
      context,
      renderPokemonCenterRecovery(),
      active.value.sessionId,
      null,
      ":center:heal",
    );
  };

  const pc: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }

    return textResult(
      context,
      renderWorldServiceEntry("PC"),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":center:pc",
    );
  };

  const converse: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }

    return textResult(
      context,
      renderCenterConversationMenu(),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":center:conversation",
    );
  };

  return [
    {
      command: "pokemart",
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMART")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "comprar",
      handler: new FunctionalHandler(buy),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "vender",
      handler: new FunctionalHandler(sell),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "centropokemon",
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMON_CENTER")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "curar",
      handler: new FunctionalHandler(heal),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pc",
      handler: new FunctionalHandler(pc),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "conversar",
      handler: new FunctionalHandler(converse),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "sair",
      handler: new FunctionalHandler(close),
      policy: WORLD_SERVICE_POLICY,
    },
  ];
}
