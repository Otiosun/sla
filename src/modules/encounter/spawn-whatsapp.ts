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

export interface SpawnWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly encounters: Pick<EncounterService, "createOrReplay"> &
    Partial<Pick<EncounterService, "observe">>;
  readonly context?: NarratorSpawnContextResolver;
  readonly speciesDisplayName?: (
    contentReleaseId: string,
    speciesId: string,
  ) => Promise<string | null>;
}

function result(
  context: MessageHandlerContext,
  text: string,
  encounterId: string | null,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: encounterId === null ? null : "ENCOUNTER",
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

function requestedQuantity(context: MessageHandlerContext): Result<number> {
  const tokens = context.message.text?.trim().split(/\s+/) ?? [];
  const tail = tokens.at(-1) ?? "";
  if (!/^\d+$/.test(tail)) return ok(1);
  const quantity = Number(tail);
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 6
    ? ok(quantity)
    : err(appError("VALIDATION_FAILED", "A quantidade do spawn deve estar entre 1 e 6."));
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
            "Use `/spawn @treinador` com exatamente uma menção real. Se ele estiver em party, a party inteira será validada.",
          ),
        );
      }
      const quantity = requestedQuantity(context);
      if (!quantity.ok) return quantity;

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
        );
      }

      if (spawnContext.kind === "SPLIT") {
        return result(context, splitText(spawnContext.groups), null);
      }

      const created = await dependencies.encounters.createOrReplay({
        playerId: target.value.playerId,
        participantPlayerIds: [],
        spawnQuantity: quantity.value,
        idempotencyKey: context.idempotencyKey,
      });
      if (!created.ok) return created;

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
        presented.value.encounterId,
      );
    }),
  };
}
