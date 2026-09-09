import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import { renderPokemonPcOrganizeSelection } from "./pc-organize-renderer.js";
import type { PokemonPcStorageService } from "./pc-storage-service.js";
import type { WorldServiceSessionService } from "./session-service.js";

const WORLD_SERVICE_POLICY = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
} as const;

interface Dependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly sessions: Pick<WorldServiceSessionService, "loadActiveSession">;
  readonly pcStorage?: Pick<PokemonPcStorageService, "getStorage">;
}

class OrganizeHandler implements MessageRouteHandler {
  public constructor(private readonly dependencies: Dependencies) {}

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    const resolved = await this.dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!resolved.ok) return resolved;
    const playerId: PlayerId = resolved.value.playerId;

    const active = await this.dependencies.sessions.loadActiveSession(playerId);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (this.dependencies.pcStorage === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Pokémon PC storage service is unavailable"));
    }

    const storage = await this.dependencies.pcStorage.getStorage(playerId);
    if (!storage.ok) return storage;
    const hasStoredPokemon = storage.value.boxes.some((box) => box.pokemon.length > 0);

    return ok({
      resultRefType: "WORLD_SERVICE_SESSION",
      resultRefId: active.value.sessionId,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: hasStoredPokemon
            ? {
                text: renderPokemonPcOrganizeSelection(storage.value),
                worldServicePrompt: {
                  playerId,
                  expectedRevision: active.value.revision.toString(),
                },
              }
            : { text: renderPokemonPcOrganizeSelection(storage.value) },
          idempotencyKey: `${context.idempotencyKey}:world-service:center:pc:organize:${hasStoredPokemon ? "list" : "empty"}`,
        },
      ],
    });
  }
}

export function createPokemonPcOrganizeRoute(dependencies: Dependencies): CommandRouteDefinition {
  return {
    command: "organizar",
    handler: new OrganizeHandler(dependencies),
    policy: WORLD_SERVICE_POLICY,
  };
}
