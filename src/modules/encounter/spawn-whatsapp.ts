import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterEnvironmentContext } from "../catalog/encounter-contracts.js";
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
  readonly environment?: () => EncounterEnvironmentContext;
  readonly autoBattle?: NarratorAutoBattlePort;
}

interface SpawnCommandOptions {
  readonly automatic: boolean;
  readonly quantity: number;
  readonly speciesReference: string | null;
}

function result(
  context: MessageHandlerContext,
  text: string,
  refType: "ENCOUNTER" | "BATTLE" | null,
  refId: string | null,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: refType,
    resultRefId: refId,
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

function parseCommand(context: MessageHandlerContext): Result<SpawnCommandOptions> {
  const raw = context.message.text?.trim() ?? "";
  const tokens = raw.split(/\s+/u).slice(1);
  const meaningful = tokens.filter((token) => !token.startsWith("@"));

  let quantity = 1;
  const tail = meaningful.at(-1) ?? "";
  if (/^\d+$/u.test(tail)) {
    quantity = Number(tail);
    meaningful.pop();
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 6) {
    return err(appError("VALIDATION_FAILED", "A quantidade do spawn deve estar entre 1 e 6."));
  }

  let automatic = false;
  if (meaningful[0]?.toLocaleLowerCase("pt-BR") === "auto") {
    automatic = true;
    meaningful.shift();
  }

  const speciesReference = meaningful.join(" ").trim();
  if (speciesReference.length > 80) {
    return err(appError("VALIDATION_FAILED", "O nome do Pokémon informado é muito longo."));
  }

  return ok({
    automatic,
    quantity,
    speciesReference: speciesReference.length === 0 ? null : speciesReference,
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
    "Escolha um participante de uma área comum ou reúna o grupo antes do spawn.",
  ].join("\n");
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
        return err(
          appError(
            "VALIDATION_FAILED",
            "Use `/spawn @treinador` com exatamente uma menção real. Também são aceitos `/spawn Poochyena @treinador` e `/spawn auto Poochyena @treinador`.",
          ),
        );
      }

      const parsed = parseCommand(context);
      if (!parsed.ok) return parsed;

      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: mentions[0],
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
            "",
            "Aguarde o deslocamento terminar antes de gerar um encontro.",
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
      let forcedDisplayName: string | null = null;
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
        forcedDisplayName = match.displayName;
      }

      const created = await dependencies.encounters.createOrReplay({
        playerId: target.value.playerId,
        participantPlayerIds: [],
        spawnQuantity: parsed.value.quantity,
        ...(forcedFormId === undefined ? {} : { forcedFormId }),
        ...(environment === undefined ? {} : { environment }),
        idempotencyKey: context.idempotencyKey,
      });
      if (!created.ok) {
        if (forcedDisplayName !== null) {
          return err(
            appError(created.error.code, created.error.message, {
              ...created.error.details,
              userMessage: `*${forcedDisplayName}* não está disponível para spawn nesta área/período agora.`,
            }),
          );
        }
        return created;
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

      const wildLines = await Promise.all(
        wilds.map(async (wild) => {
          const name =
            dependencies.speciesDisplayName === undefined
              ? "Pokémon selvagem"
              : ((await dependencies.speciesDisplayName(
                  presented.value.contentReleaseId,
                  wild.snapshot.speciesId,
                )) ?? "Pokémon selvagem");
          return wilds.length === 1
            ? `*${name}* · Nv. ${wild.snapshot.level}`
            : `${wild.wildNo}. *${name}* · Nv. ${wild.snapshot.level}`;
        }),
      );

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
            "🤖 *BATALHA AUTOMÁTICA INICIADA*",
            "",
            `_${spawnContext.areaDisplayName}_`,
            "",
            ...wildLines,
            "",
            spawnContext.participantCount === 1
              ? "O treinador marcado participa desta batalha."
              : `A party co-localizada participa · ${spawnContext.participantCount} treinadores.`,
            "",
            "Treinador e adversário estão sob controle automático.",
            "_O primeiro turno já foi disparado; os próximos seguem pelo runtime._",
          ].join("\n"),
          "BATTLE",
          started.value.battleId,
        );
      }

      return result(
        context,
        [
          wilds.length === 1 ? "🌿 *ENCONTRO SELVAGEM*" : "🌿 *ENCONTRO SELVAGEM · GRUPO*",
          "",
          `_Cena conduzida pelo narrador em ${spawnContext.areaDisplayName}._`,
          "",
          ...wildLines,
          "",
          spawnContext.participantCount === 1
            ? "O treinador marcado participa deste encontro."
            : `A party co-localizada participa deste encontro · ${spawnContext.participantCount} treinadores.`,
          "",
          "O narrador decide quando a cena vira combate.",
          "⚔️ `/iniciarbatalha @treinador`",
        ].join("\n"),
        "ENCOUNTER",
        presented.value.encounterId,
      );
    }),
  };
}
