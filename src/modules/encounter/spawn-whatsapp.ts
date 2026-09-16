import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { EncounterService } from "./service.js";

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

export interface SpawnWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly encounters: Pick<EncounterService, "createOrReplay">;
}

function result(
  context: MessageHandlerContext,
  text: string,
  encounterId: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "ENCOUNTER",
    resultRefId: encounterId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:spawn`,
      },
    ],
  });
}

export function createSpawnWhatsAppRoute(
  dependencies: SpawnWhatsAppDependencies,
): CommandRouteDefinition {
  return {
    command: "spawn",
    rateLimitClass: "SENSITIVE",
    policy: { requiredGroupCapabilities: ["pve"], requiredAdminCapability: "encounter.support" },
    handler: new FunctionalHandler(async (context) => {
      const mentions = context.message.mentions ?? [];
      if (mentions.length !== 1) {
        return err(appError("VALIDATION_FAILED", "Use /spawn com exatamente uma menção real."));
      }
      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: mentions[0],
      });
      if (!target.ok) return target;
      const created = await dependencies.encounters.createOrReplay({
        playerId: target.value.playerId,
        participantPlayerIds: [],
        idempotencyKey: context.idempotencyKey,
      });
      if (!created.ok) return created;
      return result(
        context,
        `🌿 Encontro criado para o treinador marcado · Nv. ${created.value.snapshot.level}.`,
        created.value.encounterId,
      );
    }),
  };
}
