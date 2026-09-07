import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type { WorldServiceKind } from "./contracts.js";
import { renderWorldServiceEntry, renderWorldServiceExit } from "./renderer.js";
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
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

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
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_SESSION",
    resultRefId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:world-service`,
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

    return textResult(context, renderWorldServiceEntry(serviceKind), opened.value.sessionId);
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

  return [
    {
      command: "pokemart",
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMART")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "centropokemon",
      aliases: ["centropokémon"],
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMON_CENTER")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pc",
      handler: new FunctionalHandler(openHandler(dependencies, "PC")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "sair",
      handler: new FunctionalHandler(close),
      policy: WORLD_SERVICE_POLICY,
    },
  ];
}
