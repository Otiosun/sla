import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterEnvironmentContext } from "../catalog/encounter-contracts.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import { parseSpawnCommand } from "./spawn-command.js";
import type { EncounterService } from "./service.js";

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

export interface NarratorSpawnAreaGroup {
  readonly areaDisplayName: string;
  readonly participantDisplayNames: readonly string[];
}

export type NarratorSpawnContext =
  | {
      readonly kind: "READY";
      readonly areaDisplayName: string;
      readonly participantCount: number;
    }
  | {
      readonly kind: "SPLIT";
      readonly groups: readonly NarratorSpawnAreaGroup[];
    }
  | {
      readonly kind: "TRAVELLING";
      readonly participantDisplayNames: readonly string[];
    };

export interface NarratorSpawnContextResolver {
  resolve(playerId: string): Promise<NarratorSpawnContext>;
}

export interface NarratorSpawnSpeciesResolver {
  resolve(reference: string): Promise<{
    readonly formId: string;
    readonly displayName: string;
  } | null>;
}

export interface NarratorAutoBattlePort {
  start(input: {
    readonly playerId: string;
    readonly encounterId: string;
    readonly status: "PRESENTED";
    readonly expectedRevision: bigint;
  }): Promise<
    | { readonly ok: true; readonly value: { readonly battleId: string } }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >;
  automatePlayers(battleId: string): Promise<{ readonly automated: number }>;
  kick(battleId: string): Promise<unknown>;
}

export interface NarratorOpeningBattlePreview {
  readonly displayName: string;
  readonly level: number;
  readonly shiny: boolean;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly moves: readonly {
    readonly slotNo: number;
    readonly displayName: string;
    readonly ppCurrent: number | null;
    readonly maxPp: number | null;
  }[];
}

export interface NarratorOpeningBattlePort {
  start(input: {
    readonly playerId: string;
    readonly encounterId: string;
    readonly status: "PRESENTED";
    readonly expectedRevision: bigint;
    readonly provider: string;
    readonly narratorExternalId: string;
    readonly moveSlot: number;
    readonly idempotencyKey: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly battleId: string;
          readonly moveDisplayName: string;
          readonly player: NarratorOpeningBattlePreview;
        };
      }
    | {
        readonly ok: false;
        readonly error: {
          readonly message: string;
          readonly battleId?: string;
        };
      }
  >;
}

export interface SpawnWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly encounters: Pick<EncounterService, "createOrReplay"> &
    Partial<Pick<EncounterService, "observe">>;
  readonly context?: NarratorSpawnContextResolver;
  readonly species?: NarratorSpawnSpeciesResolver;
  readonly speciesDisplayName?: (
    contentReleaseId: string,
    speciesId: string,
  ) => Promise<string | null>;
  readonly moveDisplayNames?: (
    contentReleaseId: string,
    moveIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  readonly environment?: () => EncounterEnvironmentContext;
  readonly autoBattle?: NarratorAutoBattlePort;
  readonly narratorOpening?: NarratorOpeningBattlePort;
}

function mentionTag(ref: string): string {
  const local = ref.split("@", 1)[0] ?? ref;
  return `@${local.replace(/:\d+$/u, "")}`;
}

function result(
  context: MessageHandlerContext,
  text: string,
  refType: "ENCOUNTER" | "BATTLE" | null,
  refId: string | null,
  mentions: readonly string[] = [],
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: refType,
    resultRefId: refId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text,
          ...(mentions.length === 0 ? {} : { mentions }),
        },
        idempotencyKey: `${context.idempotencyKey}:spawn`,
      },
    ],
  });
}

function splitText(groups: readonly NarratorSpawnAreaGroup[]): string {
  const sections = groups.map((group) =>
    [
      `*${group.areaDisplayName}*`,
      ...group.participantDisplayNames.map((name) => `• ${name}`),
    ].join("\n"),
  );

  return [
    "⚠️ *GRUPO DIVIDIDO*",
    "",
    "_O encontro não foi criado._",
    "",
    ...sections.flatMap((section, index) => (index === 0 ? [section] : ["", section])),
    "",
    "Reúna o grupo ou escolha alguém de uma área comum.",
  ].join("\n");
}

function normalizeLookup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ");
}

async function openingMoveFor(
  contentReleaseId: string,
  wild: {
    readonly snapshot: {
      readonly moves: readonly { readonly moveId: string }[];
    };
  },
  reference: string,
  presentation: NonNullable<SpawnWhatsAppDependencies["moveDisplayNames"]>,
): Promise<{ readonly slotNo: number; readonly displayName: string } | null> {
  const normalized = normalizeLookup(reference);
  const names = await presentation(
    contentReleaseId,
    wild.snapshot.moves.map((move) => move.moveId),
  );

  if (/^\d+$/u.test(normalized)) {
    const slot = Number(normalized);
    const source = wild.snapshot.moves[slot - 1];
    if (source === undefined) return null;
    return {
      slotNo: slot,
      displayName: names.get(source.moveId) ?? `Golpe ${slot}`,
    };
  }

  const matches = wild.snapshot.moves.flatMap((move, index) => {
    const displayName = names.get(move.moveId);
    return displayName !== undefined && normalizeLookup(displayName) === normalized
      ? [{ slotNo: index + 1, displayName }]
      : [];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function availableMoveText(
  contentReleaseId: string,
  wild: {
    readonly snapshot: {
      readonly moves: readonly { readonly moveId: string }[];
    };
  },
  presentation: NonNullable<SpawnWhatsAppDependencies["moveDisplayNames"]>,
): Promise<string> {
  const names = await presentation(
    contentReleaseId,
    wild.snapshot.moves.map((move) => move.moveId),
  );
  return wild.snapshot.moves
    .map((move, index) => `${index + 1}. ${names.get(move.moveId) ?? "Movimento"}`)
    .join(" · ");
}

function creationUserMessage(message: string): string | null {
  if (message.includes("active encounter")) {
    return "Esse treinador já possui um encontro ativo. Use `/finalizarbatalha @treinador` para encerrá-lo.";
  }
  if (message.includes("active-battle") || message.includes("active battle")) {
    return "Esse treinador já está em batalha.";
  }
  if (message.includes("Party is not eligible") || message.includes("Party membership changed")) {
    return "A party mudou, está separada ou não está pronta para esse encontro.";
  }
  if (message.includes("No eligible encounter table")) {
    return "Não há uma faixa de encontro válida nesta área/período agora.";
  }
  if (message.includes("no eligible active entries")) {
    return "A área não possui uma faixa de nível elegível para esse spawn agora.";
  }
  if (message.includes("Player location is missing")) {
    return "O treinador ainda não possui uma localização válida no mundo.";
  }
  return null;
}

function ppText(current: number | null, max: number | null): string {
  if (current === null && max === null) return "";
  return ` · PP \`${current ?? "—"}/${max ?? "—"}\``;
}

function openingBattleText(
  targetRef: string,
  wildName: string,
  wildLevel: number,
  wildShiny: boolean,
  area: string,
  moveName: string,
  player: NarratorOpeningBattlePreview,
): string {
  const playerShiny = player.shiny ? " ✨" : "";
  const wildSparkle = wildShiny ? " ✨" : "";
  return [
    "⚔️ *BATALHA INICIADA*",
    "",
    `${mentionTag(targetRef)} · *${player.displayName}*${playerShiny} Nv. ${player.level}  ×  *${wildName}*${wildSparkle} Nv. ${wildLevel}`,
    `📍 ${area}`,
    "",
    `🎙️ *${moveName}* registrado · aguardando o treinador.`,
    "",
    "*Seus golpes*",
    ...player.moves.map(
      (move) => `\`${move.slotNo}\` ${move.displayName}${ppText(move.ppCurrent, move.maxPp)}`,
    ),
    "",
    "`/movimento 1` · `/capturar` · `/fugir`",
    "`/batalha` · consultar estado",
  ].join("\n");
}

export function createSpawnWhatsAppRoute(
  dependencies: SpawnWhatsAppDependencies,
): CommandRouteDefinition {
  return {
    command: "spawn",
    allowEmbedded: true,
    rateLimitClass: "SENSITIVE",
    policy: { requiredGroupCapabilities: ["pve"], requiredAdminCapability: "encounter.support" },
    handler: new FunctionalHandler(async (context) => {
      const mentions = context.message.mentions ?? [];
      if (mentions.length !== 1) {
        return err(
          appError("VALIDATION_FAILED", "Use /spawn com exatamente uma menção real.", {
            userMessage:
              "Use `/spawn @treinador`, `/spawn Poochyena @treinador` ou combine modificadores como `nv 10`, `shiny`, `ataque Bite` e `auto`.",
          }),
        );
      }
      const targetRef = mentions[0];
      if (targetRef === undefined) {
        return err(appError("VALIDATION_FAILED", "Spawn target mention is missing."));
      }

      const parsed = parseSpawnCommand(context.message.text);
      if (!parsed.ok) {
        return err(
          appError("VALIDATION_FAILED", parsed.message, {
            userMessage: parsed.message,
          }),
        );
      }

      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: targetRef,
      });
      if (!target.ok) return target;

      const spawnContext =
        dependencies.context === undefined
          ? { kind: "READY" as const, areaDisplayName: "Área atual", participantCount: 1 }
          : await dependencies.context.resolve(target.value.playerId);

      if (spawnContext.kind === "TRAVELLING") {
        return result(
          context,
          [
            "🚶 *GRUPO EM DESLOCAMENTO*",
            "",
            "_O encontro não foi criado._",
            "",
            ...spawnContext.participantDisplayNames.map((name) => `• ${name}`),
          ].join("\n"),
          null,
          null,
        );
      }
      if (spawnContext.kind === "SPLIT") {
        return result(context, splitText(spawnContext.groups), null, null);
      }

      let environment: EncounterEnvironmentContext | undefined;
      if (dependencies.environment !== undefined) {
        try {
          environment = dependencies.environment();
        } catch (error) {
          return err(
            appError(
              "FEATURE_UNAVAILABLE",
              error instanceof Error ? error.message : "Encounter environment is unavailable",
              {
                userMessage:
                  "A configuração explícita do período do mundo é inválida. Remova o override ou use DAY/NIGHT.",
              },
            ),
          );
        }
      }

      let forcedFormId: string | undefined;
      if (parsed.value.speciesReference !== null) {
        if (dependencies.species === undefined) {
          return err(
            appError("FEATURE_UNAVAILABLE", "Narrator species resolver is unavailable", {
              userMessage: "Spawn por espécie não está disponível agora.",
            }),
          );
        }
        const match = await dependencies.species.resolve(parsed.value.speciesReference);
        if (match === null) {
          return err(
            appError("VALIDATION_FAILED", "Requested spawn species was not found", {
              userMessage: `Não encontrei *${parsed.value.speciesReference}* no conteúdo ativo.`,
            }),
          );
        }
        forcedFormId = match.formId;
      }

      const effectiveFirstTurn =
        parsed.value.firstTurn ??
        (parsed.value.openingMoveReference === null ? null : ("WILD" as const));

      const created = await dependencies.encounters.createOrReplay({
        playerId: target.value.playerId,
        participantPlayerIds: [],
        spawnQuantity: parsed.value.quantity,
        ...(forcedFormId === undefined ? {} : { forcedFormId }),
        ...(parsed.value.forcedLevel === null ? {} : { forcedLevel: parsed.value.forcedLevel }),
        ...(parsed.value.forcedShiny ? { forcedShiny: true } : {}),
        ...(effectiveFirstTurn === null ? {} : { firstTurnInitiative: effectiveFirstTurn }),
        ...(environment === undefined ? {} : { environment }),
        idempotencyKey: context.idempotencyKey,
      });
      if (!created.ok) {
        const userMessage = creationUserMessage(created.error.message);
        return userMessage === null
          ? created
          : err(
              appError(created.error.code, created.error.message, {
                ...created.error.details,
                userMessage,
              }),
            );
      }

      const presented =
        dependencies.encounters.observe === undefined
          ? created
          : await dependencies.encounters.observe({
              playerId: target.value.playerId,
              encounterId: created.value.encounterId,
              expectedRevision: created.value.revision,
            });
      if (!presented.ok) return presented;

      const wilds =
        presented.value.wilds === undefined || presented.value.wilds.length === 0
          ? [{ wildNo: 1, status: "ACTIVE" as const, snapshot: presented.value.snapshot }]
          : presented.value.wilds;

      const wildNames = await Promise.all(
        wilds.map(async (wild) =>
          dependencies.speciesDisplayName === undefined
            ? "Pokémon selvagem"
            : ((await dependencies.speciesDisplayName(
                presented.value.contentReleaseId,
                wild.snapshot.speciesId,
              )) ?? "Pokémon selvagem"),
        ),
      );

      const wildLines = wilds.map((wild, index) => {
        const name = wildNames[index] ?? "Pokémon selvagem";
        const sparkle = wild.snapshot.shiny ? " ✨" : "";
        return wilds.length === 1
          ? `*${name}*${sparkle} · Nv. ${wild.snapshot.level}`
          : `${wild.wildNo}. *${name}*${sparkle} · Nv. ${wild.snapshot.level}`;
      });

      if (parsed.value.openingMoveReference !== null) {
        const wild = wilds[0];
        if (wild === undefined) {
          return err(appError("FLOW_BLOCKED", "Spawn fast path has no wild actor."));
        }
        if (
          dependencies.moveDisplayNames === undefined ||
          dependencies.narratorOpening === undefined
        ) {
          return err(
            appError("FEATURE_UNAVAILABLE", "Narrator opening battle is unavailable", {
              userMessage: "O fast path com *ataque* não está disponível agora.",
            }),
          );
        }
        const move = await openingMoveFor(
          presented.value.contentReleaseId,
          wild,
          parsed.value.openingMoveReference,
          dependencies.moveDisplayNames,
        );
        if (move === null) {
          const available = await availableMoveText(
            presented.value.contentReleaseId,
            wild,
            dependencies.moveDisplayNames,
          );
          return err(
            appError("VALIDATION_FAILED", "Opening move was not found in the wild snapshot", {
              userMessage: `Esse Pokémon não possui *${parsed.value.openingMoveReference}* nesse nível.\nGolpes: ${available}`,
            }),
          );
        }

        const started = await dependencies.narratorOpening.start({
          playerId: target.value.playerId,
          encounterId: presented.value.encounterId,
          status: "PRESENTED",
          expectedRevision: presented.value.revision,
          provider: context.message.provider,
          narratorExternalId: context.message.senderRef,
          moveSlot: move.slotNo,
          idempotencyKey: `${context.idempotencyKey}:opening`,
        });
        if (!started.ok) {
          return err(
            appError("FLOW_BLOCKED", started.error.message, {
              userMessage:
                started.error.battleId === undefined
                  ? "Não foi possível iniciar a batalha rápida."
                  : "A batalha foi iniciada, mas o ataque inicial não pôde ser registrado. Use `/batalha` para continuar.",
            }),
          );
        }

        return result(
          context,
          openingBattleText(
            targetRef,
            wildNames[0] ?? "Pokémon selvagem",
            wild.snapshot.level,
            wild.snapshot.shiny,
            spawnContext.areaDisplayName,
            started.value.moveDisplayName,
            started.value.player,
          ),
          "BATTLE",
          started.value.battleId,
          [targetRef],
        );
      }

      if (parsed.value.automatic) {
        if (dependencies.autoBattle === undefined) {
          return err(
            appError("FEATURE_UNAVAILABLE", "Automatic PVE battle is unavailable", {
              userMessage: "O modo de batalha automática não está disponível agora.",
            }),
          );
        }
        const started = await dependencies.autoBattle.start({
          playerId: target.value.playerId,
          encounterId: presented.value.encounterId,
          status: "PRESENTED",
          expectedRevision: presented.value.revision,
        });
        if (!started.ok) {
          return err(
            appError("FLOW_BLOCKED", started.error.message, {
              userMessage: "O encontro foi criado, mas a batalha automática não pôde ser iniciada.",
            }),
          );
        }

        try {
          await dependencies.autoBattle.automatePlayers(started.value.battleId);
          await dependencies.autoBattle.kick(started.value.battleId);
        } catch (error) {
          return err(
            appError(
              "FLOW_BLOCKED",
              error instanceof Error ? error.message : "Automatic battle activation failed",
              {
                userMessage:
                  "A batalha foi criada, mas o controle automático não pôde ser ativado. Use `/batalha` para verificar o estado.",
              },
            ),
          );
        }

        return result(
          context,
          [
            "🤖 *BATALHA AUTOMÁTICA*",
            "",
            `${mentionTag(targetRef)} · ${wildLines.join(" · ")}`,
            `📍 ${spawnContext.areaDisplayName}`,
            "",
            "_Treinador e adversário estão sob controle da IA._",
            "_Sem spam por turno; o resultado/recompensa aparece ao final._",
          ].join("\n"),
          "BATTLE",
          started.value.battleId,
          [targetRef],
        );
      }

      return result(
        context,
        [
          wilds.length === 1 ? "🌿 *ENCONTRO SELVAGEM*" : "🌿 *ENCONTRO SELVAGEM · GRUPO*",
          "",
          mentionTag(targetRef),
          ...wildLines,
          `📍 ${spawnContext.areaDisplayName}`,
          "",
          `⚔️ \`/iniciarbatalha ${mentionTag(targetRef)}\``,
        ].join("\n"),
        "ENCOUNTER",
        presented.value.encounterId,
        [targetRef],
      );
    }),
  };
}
