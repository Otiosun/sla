import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterMutationInput } from "../encounter/contracts.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { EncounterService } from "../encounter/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { BattleRuntimeService } from "./runtime.js";

export interface CanonicalPveBattleStartInput extends EncounterMutationInput {
  readonly status: "CREATED" | "PRESENTED" | "ENGAGED" | "IN_BATTLE";
}

export class PveBattleStartService {
  public constructor(
    private readonly encounter: Pick<EncounterService, "observe" | "engage" | "startBattle">,
    private readonly battle: Pick<BattleRuntimeService, "initialize">,
  ) {}

  public async start(input: EncounterMutationInput) {
    const started = await this.encounter.startBattle(input);
    if (!started.ok) return started;

    const initialized = await this.battle.initialize(started.value.battleId);
    if (!initialized.ok) return initialized;

    return {
      ok: true as const,
      value: {
        start: started.value,
        initialization: initialized.value,
      },
    };
  }

  public async startCanonical(input: CanonicalPveBattleStartInput) {
    let revision = input.expectedRevision;

    if (input.status === "CREATED") {
      const observed = await this.encounter.observe({
        playerId: input.playerId,
        encounterId: input.encounterId,
        expectedRevision: revision,
      });
      if (!observed.ok) return observed;

      revision = observed.value.revision;
    }

    if (input.status === "CREATED" || input.status === "PRESENTED") {
      const engaged = await this.encounter.engage({
        playerId: input.playerId,
        encounterId: input.encounterId,
        expectedRevision: revision,
      });
      if (!engaged.ok) return engaged;

      revision = engaged.value.revision;
    }

    return this.start({
      playerId: input.playerId,
      encounterId: input.encounterId,
      expectedRevision: revision,
    });
  }
}

export interface PveBattleStartWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly encounters: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly start: Pick<PveBattleStartService, "startCanonical">;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}

  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

function isCanonicalStartStatus(status: string): status is CanonicalPveBattleStartInput["status"] {
  return (
    status === "CREATED" || status === "PRESENTED" || status === "ENGAGED" || status === "IN_BATTLE"
  );
}

export function createPveBattleStartWhatsAppRoute(
  dependencies: PveBattleStartWhatsAppDependencies,
): CommandRouteDefinition {
  return {
    command: "iniciarbatalha",
    rateLimitClass: "SENSITIVE",
    policy: {
      requiredGroupCapabilities: ["pve"],
      requiredAdminCapability: "encounter.support",
    },
    handler: new FunctionalHandler(async (context) => {
      const mentions = context.message.mentions ?? [];

      if (mentions.length !== 1) {
        return err(
          appError("VALIDATION_FAILED", "Use /iniciarbatalha com exatamente uma menção real."),
        );
      }

      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: mentions[0],
      });

      if (!target.ok) return target;

      const active = await dependencies.encounters.activeForPlayer(target.value.playerId);

      if (!active.ok) return active;

      if (!isCanonicalStartStatus(active.value.status)) {
        return err(
          appError("FLOW_BLOCKED", "O encontro ativo não pode iniciar uma batalha neste estado.", {
            userMessage: "O encontro ativo ainda não pode iniciar uma batalha neste estado.",
          }),
        );
      }

      const started = await dependencies.start.startCanonical({
        playerId: target.value.playerId,
        encounterId: active.value.encounterId,
        status: active.value.status,
        expectedRevision: active.value.revision,
      });

      if (!started.ok) {
        return err(
          appError("FLOW_BLOCKED", started.error.message, {
            userMessage: "Não foi possível iniciar a batalha a partir do estado atual do encontro.",
          }),
        );
      }

      const battleId = started.value.start.battleId;

      return ok({
        resultRefType: "BATTLE",
        resultRefId: battleId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: {
              text: "⚔️ Batalha iniciada. O treinador já pode usar `/batalha`.",
            },
            idempotencyKey: `${context.idempotencyKey}:pve-battle-start`,
          },
        ],
      });
    }),
  };
}
