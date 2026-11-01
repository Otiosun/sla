import type { Clock } from "../../platform/clock/index.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import {
  EXPEDITION_DURATION_MINUTES,
  EXPEDITION_WEEKLY_LIMIT,
  expeditionClock,
} from "./expedition-clock.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";
import { expeditionWeekKey, expeditionWeeklyAdmission } from "./expedition-week.js";

/**
 * Optional, read-only staging route. There is deliberately no action handler,
 * expedition write port, EncounterService, or CaptureService in this interface.
 * Never register it by default or against a production database with a
 * non-migrated solo_expeditions draft schema.
 */
export interface ExpeditionV4StatusFacts {
  readonly expedition: ExpeditionSnapshot | null;
  readonly usedThisWeek: number;
}

export interface ExpeditionV4ReadOnlyDeps {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly facts: {
    read(playerId: PlayerId, weekKey: string): Promise<ExpeditionV4StatusFacts>;
  };
  readonly group: {
    admits(input: {
      readonly provider: string;
      readonly chatRef: string;
      readonly playerId: PlayerId;
    }): Promise<boolean>;
  };
  readonly clock: Clock;
  readonly timeZone: string;
}

function privateText(context: MessageHandlerContext, text: string): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:exploration-readonly`,
      },
    ],
  });
}

function safeLabel(value: string): string | null {
  const text = value
    .replace(/[\r\n*_~`<>/]/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\u031d/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > 0 && text.length <= 70 && !text.includes("[Ler mais]") ? text : null;
}

function validExpedition(
  expedition: ExpeditionSnapshot,
  playerId: PlayerId,
  areaId: string,
): boolean {
  if (
    expedition.playerId !== playerId ||
    expedition.areaId !== areaId ||
    expedition.revision < 0n
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(expedition.elapsedMinutes) ||
    !["DAY", "NIGHT"].includes(expedition.period)
  ) {
    return false;
  }
  if (expedition.phase === "PREPARING") {
    return (
      expedition.elapsedMinutes === 0 &&
      expedition.consumedWeekKey === null &&
      expedition.endReason === null
    );
  }
  return (
    expedition.phase === "ACTIVE" &&
    expedition.elapsedMinutes > 0 &&
    expedition.elapsedMinutes < EXPEDITION_DURATION_MINUTES &&
    expedition.consumedWeekKey !== null &&
    expedition.endReason === null
  );
}

class ExpeditionV4ReadOnlyHandler implements MessageRouteHandler {
  public constructor(private readonly deps: ExpeditionV4ReadOnlyDeps) {
    // The configured calendar must be validated even if no trainer calls the command.
    expeditionWeekKey(deps.clock.now(), deps.timeZone);
  }

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    if (!/^\/explorar(?:\s+(?:status|retomar))?$/iu.test(context.message.text?.trim() ?? "")) {
      return privateText(
        context,
        "◇ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔*\n\nEsta prévia permite somente `/explorar status` ou `/explorar retomar`.\nNenhuma ação será executada.",
      );
    }

    const identified = await this.deps.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!identified.ok) return identified;
    if (identified.value.state !== "COMPLETE") {
      return err(
        appError("PLAYER_INELIGIBLE", "Conclua seu cadastro antes de consultar a expedição."),
      );
    }
    const playerId = identified.value.playerId;
    if (
      !(await this.deps.group.admits({
        provider: context.message.provider,
        chatRef: context.message.chatRef,
        playerId,
      }))
    ) {
      return err(
        appError("FLOW_BLOCKED", "Exploração disponível somente no grupo GAME autorizado."),
      );
    }
    const located = await this.deps.world.getLocation(playerId);
    if (!located.ok) return located;
    const location = safeLabel(located.value.areaDisplayName);
    if (location === null || located.value.requiresRelocation) {
      return err(appError("FLOW_BLOCKED", "Localização atual não está pronta para a exploração."));
    }
    const facts = await this.deps.facts.read(
      playerId,
      expeditionWeekKey(this.deps.clock.now(), this.deps.timeZone),
    );
    if (
      !Number.isSafeInteger(facts.usedThisWeek) ||
      facts.usedThisWeek < 0 ||
      facts.usedThisWeek > EXPEDITION_WEEKLY_LIMIT ||
      (facts.expedition !== null &&
        !validExpedition(facts.expedition, playerId, located.value.areaId))
    ) {
      return err(
        appError(
          "FLOW_BLOCKED",
          "Registro da expedição está inconsistente; não há ações habilitadas.",
        ),
      );
    }
    const state: "NONE" | "PREPARING" | "ACTIVE" =
      facts.expedition === null
        ? "NONE"
        : facts.expedition.phase === "PREPARING"
          ? "PREPARING"
          : "ACTIVE";
    const quota = expeditionWeeklyAdmission(facts.usedThisWeek, state);
    const title =
      facts.expedition === null
        ? "Nenhuma expedição em andamento"
        : state === "PREPARING"
          ? "Preparação registrada"
          : "Expedição em andamento";
    const lines = [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*",
      "　Prévia segura · somente consulta",
      "",
      `⌖ *Local:* ${location}`,
      `◇ *Situação:* ${title}`,
      `🎟️ *Cotas restantes:* ${quota.remaining}/${EXPEDITION_WEEKLY_LIMIT}`,
    ];
    if (facts.expedition !== null) {
      const clock = expeditionClock(facts.expedition.period, facts.expedition.elapsedMinutes);
      lines.push(
        `${clock.period === "DAY" ? "☀️" : "🌙"} *Relógio:* \`${clock.currentTime}\` · Restam \`${clock.remainingMinutes}min\``,
      );
      if (state === "PREPARING") lines.push("⌛ *Cota ainda não consumida*");
    }
    lines.push(
      "",
      "> _Consulta sem custo. Buscar, viajar, capturar ou preparar não estão disponíveis nesta prévia._",
      "› _Nenhuma ação, cota, item ou encontro foi alterado._",
    );
    return privateText(context, lines.join("\n"));
  }
}

export function createExpeditionV4ReadOnlyRoutes(
  deps: ExpeditionV4ReadOnlyDeps,
): readonly CommandRouteDefinition[] {
  return [
    {
      command: "explorar",
      handler: new ExpeditionV4ReadOnlyHandler(deps),
      rateLimitClass: "SENSITIVE",
      policy: {
        requiredGroupCapabilities: ["world", "player.basic"],
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    },
  ];
}
