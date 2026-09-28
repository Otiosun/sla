import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterMutationInput } from "../encounter/contracts.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { EncounterService } from "../encounter/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { OperationalUxReadModel } from "../messaging/operational-ux-read-model.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { BattleState } from "./contracts.js";
import type { BattleParticipantControllerRepository } from "./participant-controller.js";
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
  readonly controllers?: Pick<BattleParticipantControllerRepository, "listByBattle">;
  readonly presentation?: Pick<OperationalUxReadModel, "speciesDisplayName" | "moveDisplayNames">;
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

function mentionTag(ref: string): string {
  const local = ref.split("@", 1)[0] ?? ref;
  return `@${local.replace(/:\d+$/u, "")}`;
}

function pp(current: number | null, max: number | null): string {
  if (current === null && max === null) return "";
  return ` · PP \`${current ?? "—"}/${max ?? "—"}\``;
}

async function battleStartText(
  dependencies: PveBattleStartWhatsAppDependencies,
  battleId: string,
  targetPlayerId: string,
  targetRef: string,
  state: BattleState,
): Promise<string> {
  const fallback = [
    "⚔️ *BATALHA INICIADA*",
    "",
    mentionTag(targetRef),
    "",
    "`/batalha` · ver Pokémon, HP e golpes",
  ].join("\n");

  const battleState = state;
  if (dependencies.controllers === undefined || dependencies.presentation === undefined) {
    return fallback;
  }
  const controllers = await dependencies.controllers.listByBattle(battleId);
  const activeIds = new Set(
    battleState.sides.flatMap((side) =>
      (side.slots ?? [side]).map((slot) => slot.activeParticipantId),
    ),
  );
  const ownController = controllers.find(
    (entry) =>
      entry.kind === "PLAYER" &&
      entry.playerId === targetPlayerId &&
      activeIds.has(entry.participantId),
  );
  const own =
    ownController === undefined
      ? undefined
      : battleState.combatants.find(
          (combatant) => combatant.participantId === ownController.participantId,
        );
  const opponent = battleState.combatants.find(
    (combatant) =>
      combatant.participantKind === "WILD_POKEMON" && activeIds.has(combatant.participantId),
  );
  if (own === undefined || opponent === undefined) return fallback;

  const [ownName, opponentName, moveNames] = await Promise.all([
    dependencies.presentation.speciesDisplayName(battleState.contentReleaseId, own.speciesId),
    dependencies.presentation.speciesDisplayName(battleState.contentReleaseId, opponent.speciesId),
    dependencies.presentation.moveDisplayNames(
      battleState.contentReleaseId,
      own.moves.map((move) => move.moveId),
    ),
  ]);
  const ownSparkle = own.shiny ? " ✨" : "";
  const opponentSparkle = opponent.shiny ? " ✨" : "";

  return [
    "⚔️ *BATALHA INICIADA*",
    "",
    `${mentionTag(targetRef)} · *${ownName ?? "Pokémon"}*${ownSparkle} Nv. ${own.level}`,
    `❤️ \`${own.currentHp}/${own.maxHp}\``,
    "",
    `× *${opponentName ?? "Pokémon selvagem"}*${opponentSparkle} Nv. ${opponent.level}`,
    `❤️ \`${opponent.currentHp}/${opponent.maxHp}\``,
    "",
    "*Seus golpes*",
    ...own.moves.map(
      (move) =>
        `\`${move.slotNo}\` ${moveNames.get(move.moveId) ?? "Movimento"}${pp(
          move.ppCurrent,
          move.maxPp,
        )}`,
    ),
    "",
    "`/movimento 1` · `/capturar` · `/fugir`",
    "`/batalha` · consultar estado",
  ].join("\n");
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
      const targetRef = mentions[0];
      if (targetRef === undefined) {
        return err(appError("VALIDATION_FAILED", "Battle target mention disappeared."));
      }
      const text = await battleStartText(
        dependencies,
        battleId,
        target.value.playerId,
        targetRef,
        started.value.initialization.state,
      );

      return ok({
        resultRefType: "BATTLE",
        resultRefId: battleId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: {
              text,
              mentions: [targetRef],
            },
            idempotencyKey: `${context.idempotencyKey}:pve-battle-start`,
          },
        ],
      });
    }),
  };
}


export interface PveBattleFinishWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly activeBattleId: (playerId: PlayerId) => Promise<string | null>;
  readonly battle: Pick<BattleRuntimeService, "currentState" | "cancel">;
  readonly encounters: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly encounterWriter: Pick<EncounterService, "flee">;
}

export function createPveBattleFinishWhatsAppRoute(
  dependencies: PveBattleFinishWhatsAppDependencies,
): CommandRouteDefinition {
  return {
    command: "finalizarbatalha",
    aliases: ["encerrarbatalha", "cancelarbatalha", "finalizarencontro", "encerrarencontro"],
    rateLimitClass: "SENSITIVE",
    policy: {
      requiredGroupCapabilities: ["pve"],
      requiredAdminCapability: "encounter.support",
    },
    handler: new FunctionalHandler(async (context) => {
      const mentions = context.message.mentions ?? [];
      if (mentions.length !== 1) {
        return err(
          appError("VALIDATION_FAILED", "Use /finalizarbatalha com exatamente uma menção real.", {
            userMessage: "Use `/finalizarbatalha @treinador`.",
          }),
        );
      }
      const targetRef = mentions[0];
      if (targetRef === undefined) {
        return err(appError("VALIDATION_FAILED", "Battle finish target mention is missing."));
      }
      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: targetRef,
      });
      if (!target.ok) return target;

      const battleId = await dependencies.activeBattleId(target.value.playerId);
      if (battleId !== null) {
        const state = await dependencies.battle.currentState(battleId);
        if (!state.ok) {
          return err(
            appError("FLOW_BLOCKED", state.error.message, {
              userMessage: "A batalha ativa não pôde ser lida agora.",
            }),
          );
        }
        const cancelled = await dependencies.battle.cancel({
          battleId,
          expectedVersion: state.value.version,
          reason: "NARRATOR_FINISH",
          correlationId: context.correlationId,
        });
        if (!cancelled.ok) {
          return err(
            appError("FLOW_BLOCKED", cancelled.error.message, {
              userMessage: "Não foi possível encerrar essa batalha agora.",
            }),
          );
        }
        return ok({
          resultRefType: "BATTLE",
          resultRefId: battleId,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: {
                text: `🛑 *BATALHA ENCERRADA* · ${mentionTag(targetRef)}`,
                mentions: [targetRef],
              },
              idempotencyKey: `${context.idempotencyKey}:pve-battle-finish`,
            },
          ],
        });
      }

      const encounter = await dependencies.encounters.activeForPlayer(target.value.playerId);
      if (!encounter.ok) {
        return ok({
          resultRefType: null,
          resultRefId: null,
          outgoing: [
            {
              channel: "whatsapp",
              destinationRef: context.message.chatRef,
              messageType: "TEXT",
              payload: {
                text: `ℹ️ ${mentionTag(targetRef)} não possui encontro ou batalha ativa.`,
                mentions: [targetRef],
              },
              idempotencyKey: `${context.idempotencyKey}:pve-battle-finish-none`,
            },
          ],
        });
      }
      if (!["CREATED", "PRESENTED", "ENGAGED"].includes(encounter.value.status)) {
        return err(
          appError("FLOW_BLOCKED", "Active encounter cannot be narrator-finished from this state", {
            userMessage: "Esse encontro está em uma transição mecânica e não pode ser encerrado agora.",
          }),
        );
      }
      const fled = await dependencies.encounterWriter.flee({
        playerId: target.value.playerId,
        encounterId: encounter.value.encounterId,
        expectedRevision: encounter.value.revision,
      });
      if (!fled.ok) return fled;

      return ok({
        resultRefType: "ENCOUNTER",
        resultRefId: encounter.value.encounterId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: context.message.chatRef,
            messageType: "TEXT",
            payload: {
              text: `🛑 *ENCONTRO ENCERRADO* · ${mentionTag(targetRef)}`,
              mentions: [targetRef],
            },
            idempotencyKey: `${context.idempotencyKey}:pve-encounter-finish`,
          },
        ],
      });
    }),
  };
}
