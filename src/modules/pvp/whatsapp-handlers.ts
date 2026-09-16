import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PvpService } from "./service.js";

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

export interface PvpWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly pvp: Pick<PvpService, "createChallenge" | "acceptChallenge" | "startEncounter">;
  readonly openChallengeIdForTarget: (playerId: string) => Promise<string | null>;
}

function reply(context: MessageHandlerContext, text: string, refId: string) {
  return ok({
    resultRefType: "PVP",
    resultRefId: refId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:pvp`,
      },
    ],
  });
}

async function player(dependencies: PvpWhatsAppDependencies, context: MessageHandlerContext) {
  return dependencies.players.resolvePlayer({
    provider: context.message.provider,
    externalId: context.message.senderRef,
  });
}

export function createPvpWhatsAppRoutes(
  dependencies: PvpWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const challenge: Handler = async (context) => {
    const mentions = context.message.mentions ?? [];
    if (mentions.length !== 1)
      return err(appError("VALIDATION_FAILED", "Use /desafiar com exatamente uma menção real."));
    const challenger = await player(dependencies, context);
    if (!challenger.ok) return challenger;
    const target = await dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: mentions[0]!,
    });
    if (!target.ok) return target;
    const created = await dependencies.pvp.createChallenge({
      challengerPlayerId: challenger.value.playerId,
      targetPlayerId: target.value.playerId,
      formatKey: "1V1",
      reachPolicy: "SAME_AREA",
      idempotencyKey: context.idempotencyKey,
    });
    if (!created.ok) return created;
    return reply(
      context,
      created.value.replayed
        ? "⚔️ Convite PVP já está aguardando aceite."
        : "⚔️ Convite PVP enviado. Use /aceitar para iniciar.",
      created.value.challenge.id,
    );
  };
  const accept: Handler = async (context) => {
    const actor = await player(dependencies, context);
    if (!actor.ok) return actor;
    const challengeId = await dependencies.openChallengeIdForTarget(actor.value.playerId);
    if (challengeId === null) return err(appError("NOT_FOUND", "Nenhum convite PVP pendente."));
    const accepted = await dependencies.pvp.acceptChallenge({
      challengeId,
      actorPlayerId: actor.value.playerId,
    });
    if (!accepted.ok) return accepted;
    const started = await dependencies.pvp.startEncounter({
      challengeId,
      actorPlayerId: actor.value.playerId,
    });
    if (!started.ok) return started;
    return reply(
      context,
      started.value.replayed
        ? "⚔️ Batalha PVP já está em andamento."
        : "⚔️ Batalha PVP iniciada. Envie sua cena e a ação na última linha.",
      started.value.battleId,
    );
  };
  return [
    {
      command: "desafiar",
      handler: new FunctionalHandler(challenge),
      policy: { requiredGroupCapabilities: ["pvp"], requiresMechanicalReady: true },
    },
    {
      command: "aceitar",
      handler: new FunctionalHandler(accept),
      policy: { requiredGroupCapabilities: ["pvp"], requiresMechanicalReady: true },
    },
  ];
}
