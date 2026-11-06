import type { Clock } from "../../platform/clock/index.js";
import type { StoredSearchOutcome } from "../../platform/exploration/expedition-search-outcome-effect.js";
import type { PostgresExpeditionEndConfirmationRecovery } from "../../platform/exploration/postgres-expedition-end-confirmation-recovery.js";
import type { PostgresExpeditionRepository } from "../../platform/exploration/postgres-expedition-repository.js";
import type {
  PostgresExpeditionResourceConfirmationRecovery,
  RecoveredResourceConfirmation,
} from "../../platform/exploration/postgres-expedition-resource-confirmation-recovery.js";
import type { PostgresExpeditionTrailConfirmationRecovery } from "../../platform/exploration/postgres-expedition-trail-confirmation-recovery.js";
import type { PostgresExpeditionTravelConfirmationRecovery } from "../../platform/exploration/postgres-expedition-travel-confirmation-recovery.js";
import type { PostgresExpeditionV4EventHistoryReader } from "../../platform/exploration/postgres-expedition-v4-event-history-reader.js";
import type { PostgresExpeditionV4StagingResourceSearch } from "../../platform/exploration/postgres-expedition-v4-resources.js";
import type { PostgresExpeditionV4StagingSearch } from "../../platform/exploration/postgres-expedition-v4-search.js";
import type { PostgresExpeditionV4StatusReader } from "../../platform/exploration/postgres-expedition-v4-status-reader.js";
import type { PostgresExpeditionV4StagingTrailFollow } from "../../platform/exploration/postgres-expedition-v4-trail.js";
import type { PostgresExpeditionV4StagingTravel } from "../../platform/exploration/postgres-expedition-v4-travel.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldLocationView } from "../world/contracts.js";
import type { WorldService } from "../world/service.js";
import {
  EXPEDITION_DURATION_MINUTES,
  EXPEDITION_WEEKLY_LIMIT,
  expeditionClock,
} from "./expedition-clock.js";
import { expeditionOperationAllowed } from "./expedition-runtime-audience.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";
import { renderExpeditionV4ActivePanel } from "./expedition-v4-active-panel.js";
import { renderExpeditionV4EventHistoryPanel } from "./expedition-v4-event-history-panel.js";
import {
  renderExpeditionV4OpeningPanel,
  renderExpeditionV4PreparingPanel,
} from "./expedition-v4-preparation-panel.js";
import { renderExpeditionV4SearchResultPanel } from "./expedition-v4-search-result-panel.js";
import { renderExpeditionV4TrailFollowPanel } from "./expedition-v4-trail-follow-panel.js";
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
  readonly combiningCount?: number;
  readonly reports?: MessageRouteHandler;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly facts: {
    read(playerId: PlayerId, weekKey: string): Promise<ExpeditionV4StatusFacts>;
    isRetry?(context: MessageHandlerContext): Promise<boolean>;
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
  /** Staging-only: omitted for the existing truly read-only route. */
  readonly preparation?: Pick<PostgresExpeditionRepository, "prepare" | "changePeriod" | "end">;
  /** Third explicit stage-only opt-in. No encounter route exists without it. */
  readonly search?: Pick<PostgresExpeditionV4StagingSearch, "execute"> &
    Partial<Pick<PostgresExpeditionV4StagingSearch, "recover">>;
  /** Trusted TRAIL source + canonical Encounter writer; isolated simulated WhatsApp only. */
  readonly trail?: Pick<PostgresExpeditionV4StagingTrailFollow, "readPending" | "execute">;
  /** Recover exactly the original committed follow message after Inbox failure. */
  readonly trailRecovery?: Pick<PostgresExpeditionTrailConfirmationRecovery, "resolve">;
  /** An explicit, independent 60-minute PUBLISHED resource writer in isolated development. */
  readonly resources?: Pick<PostgresExpeditionV4StagingResourceSearch, "execute">;
  /** Recover a previously committed resource without rolling or granting twice. */
  readonly resourceRecovery?: Pick<PostgresExpeditionResourceConfirmationRecovery, "resolve">;
  /** Test-only recovery of a committed END when Inbox completion was interrupted. */
  readonly endRecovery?: Pick<PostgresExpeditionEndConfirmationRecovery, "resolve">;
  /** Isolated read-only summary; never fabricates capture, XP or item grants. */
  readonly summary?: Pick<PostgresExpeditionV4StatusReader, "readLatestCompleted">;
  /** Read-only, player-scoped complete source-event timeline on isolated PG18. */
  readonly history?: Pick<PostgresExpeditionV4EventHistoryReader, "readLatestCompleted">;
  /** Complete atomic World+expedition travel, staging/test only. */
  readonly travel?: Pick<PostgresExpeditionV4StagingTravel, "execute">;
  /** Only exact, original claimed Inbox may recover a previously committed travel. */
  readonly travelRecovery?: Pick<PostgresExpeditionTravelConfirmationRecovery, "resolve">;
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

/**
 * Store a private, server-created anchor ONLY for a confirmed encounter.
 * A later staging worker must prove this exact Outbox row reached SENT before
 * advancing the canonical encounter to ENGAGED. This metadata never appears
 * in the WhatsApp text itself and cannot be supplied by a trainer.
 */
function privateSearchResult(
  context: MessageHandlerContext,
  text: string,
  playerId: PlayerId,
  outcome: StoredSearchOutcome,
  actionable = true,
): Result<MessageHandlerResult> {
  const base = privateText(context, text);
  if (!base.ok || outcome.encounterId === null) return base;
  if (outcome.playerId !== playerId || !["DIRECT", "INCIDENTAL"].includes(outcome.kind)) {
    return err(appError("FLOW_BLOCKED", "Search encounter anchor is inconsistent"));
  }
  return ok({
    ...base.value,
    resultRefType: "EXPEDITION_SEARCH_OUTCOME",
    resultRefId: outcome.outcomeId,
    outgoing: actionable
      ? base.value.outgoing.map((message) => ({
          ...message,
          payload: {
            ...message.payload,
            expeditionSearch: {
              playerId,
              outcomeId: outcome.outcomeId,
              encounterId: outcome.encounterId,
            },
          },
        }))
      : base.value.outgoing,
  });
}

function privateEndConfirmation(
  context: MessageHandlerContext,
  elapsedMinutes: number,
): Result<MessageHandlerResult> {
  return privateText(
    context,
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
      "> _Expedição encerrada voluntariamente._",
      "",
      "⌛ *Tempo utilizado:* `" + String(elapsedMinutes) + " min`",
      "🎟️ *Cota semanal já consumida*",
      "",
      "› _Nenhuma recompensa adicional foi concedida pelo encerramento._",
      "› _Relatório externo (mínimo 100 palavras) e premiação dependem de aprovação da equipe._",
    ].join("\n"),
  );
}

function privateTravelConfirmation(
  context: MessageHandlerContext,
  info: {
    readonly destinationDisplayName: string;
    readonly travelMinutes: number;
    readonly elapsedMinutes: number;
    readonly phase: "ACTIVE" | "ENDED";
  },
): Result<MessageHandlerResult> {
  const destination = safeLabel(info.destinationDisplayName);
  if (destination === null) {
    return err(appError("FLOW_BLOCKED", "Travel destination label is unsafe"));
  }
  return privateText(
    context,
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗩𝗜𝗔𝗚𝗘𝗠*",
      "⌖ *Destino:* " + destination,
      "⌛ *Tempo da viagem:* `" + String(info.travelMinutes) + " min`",
      "⌛ *Tempo acumulado:* `" + String(info.elapsedMinutes) + " min`",
      info.phase === "ENDED"
        ? "> _Expedição concluída pelo limite de tempo._"
        : "› _Consulte /explorar status para continuar na nova área._",
    ].join("\n"),
  );
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

/**
 * World PUBLISHED is authoritative. A read-only destination consultation must
 * never create an action option, invent costs, reveal locked locations or
 * silently change the player's area.
 */
function privateExpeditionDestinations(
  context: MessageHandlerContext,
  location: WorldLocationView,
  canTravel: boolean,
): Result<MessageHandlerResult> {
  const launch = new Set(["campos-de-yun", "vila-dos-arrozais"]);
  if (
    location.regionSlug !== "zhoulia" ||
    !launch.has(location.areaSlug) ||
    !/^[a-f0-9-]{36}$/iu.test(location.contentReleaseId)
  ) {
    return err(appError("FLOW_BLOCKED", "Current published area cannot offer destinations"));
  }
  const seen = new Set<string>();
  const destinations: string[] = [];
  for (const road of location.connections) {
    if (
      road.available !== true ||
      road.missingUnlockKeys.length !== 0 ||
      !launch.has(road.destinationSlug) ||
      road.destinationSlug === location.areaSlug
    ) {
      continue;
    }
    const label = safeLabel(road.destinationDisplayName);
    if (label === null || !/^[a-f0-9-]{36}$/iu.test(road.destinationAreaId)) {
      return err(appError("FLOW_BLOCKED", "Published World destination is unsafe"));
    }
    if (seen.has(road.destinationAreaId)) continue;
    seen.add(road.destinationAreaId);
    const approvedMinutes = road.explorationMinutes;
    if (
      canTravel &&
      Number.isSafeInteger(approvedMinutes) &&
      approvedMinutes !== undefined &&
      approvedMinutes > 0 &&
      approvedMinutes <= EXPEDITION_DURATION_MINUTES
    ) {
      destinations.push(
        "• " + label + " ● `" + String(approvedMinutes) + " min`",
        "› _/explorar viajar " + road.destinationSlug + "_",
      );
    } else {
      destinations.push("• " + label + " ● _tempo de viagem ainda não publicado_");
    }
  }
  const origin = safeLabel(location.areaDisplayName);
  if (origin === null) return err(appError("FLOW_BLOCKED", "World origin is unsafe"));
  return privateText(
    context,
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗗𝗘𝗦𝗧𝗜𝗡𝗢𝗦*",
      "⌖ *Local atual:* " + origin,
      "",
      "◇ *𝗖𝗢𝗡𝗘𝗫Õ𝗘𝗦 𝗗𝗜𝗦𝗣𝗢𝗡Í𝗩𝗘𝗜𝗦*",
      "",
      ...(destinations.length > 0
        ? destinations
        : ["> _Nenhum destino acessível confirmado nesta área._"]),
      "",
      "> _Consulta gratuita: não consome tempo nem cota._",
      "› _Só conexões com minutos internos publicados podem ser percorridas._",
    ].join("\n"),
  );
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

function privateResourceConfirmation(
  context: MessageHandlerContext,
  receipt: RecoveredResourceConfirmation,
): Result<MessageHandlerResult> {
  const displayName = receipt.displayName === null ? null : safeLabel(receipt.displayName);
  if (receipt.kind === "ITEM" && (displayName === null || receipt.quantity <= 0n)) {
    return err(appError("FLOW_BLOCKED", "Recurso publicado sem identificação válida."));
  }
  return privateText(
    context,
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗥𝗘𝗖𝗨𝗥𝗦𝗢𝗦*",
      receipt.kind === "ITEM"
        ? "🎒 *Encontrado:* " + displayName + " ×" + receipt.quantity.toString()
        : "> _Nenhum recurso encontrado desta vez._",
      "",
      "⌛ *Custo:* `60 min`",
      "⌛ *Tempo utilizado:* `" + String(receipt.elapsedMinutes) + " min`",
      "🎟️ *Cota da semana:* " +
        (receipt.consumedWeeklySlot ? "primeira ação contabilizada" : "sem nova cota"),
      "› _Resultado registrado no inventário canônico, quando houver item._",
    ].join("\n"),
  );
}

class ExpeditionV4ReadOnlyHandler implements MessageRouteHandler {
  public constructor(private readonly deps: ExpeditionV4ReadOnlyDeps) {
    // The configured calendar must be validated even if no trainer calls the command.
    expeditionWeekKey(deps.clock.now(), deps.timeZone);
  }

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    const text = context.message.text?.trim() ?? "";
    if (this.deps.reports && /^\/explorar\s+(?:relat[oó]rio|revisar)(?:\s|$)/iu.test(text))
      return this.deps.reports.handle(context);
    // Bare "1"/"2" require a durable menu reference and are not accepted.
    const match = /^\/explorar\s+(?:preparar\s+)?(dia|noite|1|2)$/iu.exec(text);
    const token = match?.[1]?.toLocaleLowerCase("pt-BR");
    const period: "DAY" | "NIGHT" | null =
      token === "dia" || token === "1"
        ? "DAY"
        : token === "noite" || token === "2"
          ? "NIGHT"
          : null;
    const changeMatch = /^\/explorar\s+per[ií]odo\s+(dia|noite)$/iu.exec(text);
    const requestedPeriod =
      changeMatch?.[1]?.toLocaleLowerCase("pt-BR") === "dia"
        ? "DAY"
        : changeMatch === null
          ? null
          : "NIGHT";
    const cancel = /^\/explorar\s+cancelar$/iu.test(text);
    const changePeriodRequested = /^\/explorar\s+alterar$/iu.test(text);
    const targetSearch = /^\/explorar\s+buscar\s+([a-z0-9][a-z0-9-]{0,63})$/iu.exec(text);
    const targetSpeciesSlug = targetSearch?.[1]?.toLowerCase();
    const searchFree = /^\/explorar\s+buscar$/iu.test(text) || targetSearch !== null;
    const resourceFree = /^\/explorar\s+recursos$/iu.test(text);
    const trailRequested = /^\/explorar\s+(?:seguir(?:\s+rastros)?|rastros)$/iu.test(text);
    const helpRequested = /^\/explorar\s+ajuda$/iu.test(text);
    const endRequested = /^\/explorar\s+(?:encerrar|4)$/iu.test(text);
    const destinationsRequested = /^\/explorar\s+(?:destinos|3)$/iu.test(text);
    const travelRequested = /^\/explorar\s+viajar\s+(vila-dos-arrozais|campos-de-yun)$/iu.exec(
      text,
    );
    const summaryRequested = /^\/explorar\s+resumo$/iu.test(text);
    const historyRequested = /^\/explorar\s+eventos(?:\s|$)/iu.test(text);
    const historyMatch = /^\/explorar\s+eventos(?:\s+([1-9][0-9]{0,3}))?$/iu.exec(text);
    const endConfirmed = /^\/explorar\s+encerrar\s+confirmar$/iu.test(text);
    if (
      !/^\/explorar(?:\s+(?:status|retomar|ajuda))?$/iu.test(text) &&
      (this.deps.preparation === undefined ||
        (period === null && requestedPeriod === null && !cancel && !changePeriodRequested)) &&
      (!searchFree || this.deps.search === undefined) &&
      (!resourceFree || this.deps.resources === undefined) &&
      (!trailRequested || this.deps.trail === undefined) &&
      (!(endRequested || endConfirmed) || this.deps.search === undefined) &&
      (!destinationsRequested || this.deps.preparation === undefined) &&
      (!summaryRequested || this.deps.summary === undefined) &&
      (!historyRequested || this.deps.history === undefined) &&
      (travelRequested === null || this.deps.travel === undefined)
    ) {
      return privateText(
        context,
        "◇ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗢𝗡𝗦𝗨𝗟𝗧𝗔*\n\nEsta prévia permite somente /explorar status ou /explorar retomar.\nNenhuma ação será executada.",
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
    if (historyRequested && this.deps.history !== undefined) {
      if (historyMatch === null) {
        return err(appError("VALIDATION_FAILED", "Use /explorar eventos ou /explorar eventos 2."));
      }
      const requestedPage = Number(historyMatch[1] ?? "1");
      const found = await this.deps.history.readLatestCompleted(playerId, requestedPage);
      if (!found.ok) return found;
      if (found.value === null) {
        return privateText(
          context,
          "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗛𝗜𝗦𝗧Ó𝗥𝗜𝗖𝗢*\\n\\nNenhuma expedição encerrada possui histórico disponível.",
        );
      }
      const panel = renderExpeditionV4EventHistoryPanel(found.value);
      if (!panel.ok) return panel;
      return privateText(context, panel.value);
    }
    if (summaryRequested && this.deps.summary !== undefined) {
      const latest = await this.deps.summary.readLatestCompleted(playerId);
      if (latest === null) {
        return privateText(
          context,
          "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗥𝗘𝗦𝗨𝗠𝗢*\n\nNenhuma expedição concluída com resultados registrados.",
        );
      }
      const counts = [
        latest.searches,
        latest.noSignal,
        latest.trail,
        latest.incidental,
        latest.direct,
      ];
      if (
        !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
        latest.searches !== latest.noSignal + latest.trail + latest.incidental + latest.direct ||
        !Number.isSafeInteger(latest.elapsedMinutes) ||
        latest.elapsedMinutes < 1 ||
        latest.elapsedMinutes > EXPEDITION_DURATION_MINUTES ||
        !["DAY", "NIGHT"].includes(latest.period) ||
        !["VOLUNTARY", "CLOCK", "BLACKOUT"].includes(latest.endReason)
      ) {
        return err(appError("FLOW_BLOCKED", "Persisted expedition history is inconsistent"));
      }
      const reason =
        latest.endReason === "VOLUNTARY"
          ? "Encerramento voluntário"
          : latest.endReason === "CLOCK"
            ? "Tempo esgotado"
            : "Derrota total";
      return privateText(
        context,
        [
          "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗥𝗘𝗦𝗨𝗠𝗢*",
          "> _Última expedição concluída — dados confirmados._",
          "",
          "◇ *𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
          "☀️🌙 *Período:* " + (latest.period === "DAY" ? "Diurno" : "Noturno"),
          "⌛ *Tempo utilizado:* `" + String(latest.elapsedMinutes) + " min`",
          "◇ *Término:* " + reason,
          "",
          "◇ *𝗕𝗨𝗦𝗖𝗔𝗦*",
          "🔎 Total: `" + String(latest.searches) + "`",
          "• Nenhum sinal: `" + String(latest.noSignal) + "`",
          "• Rastros: `" + String(latest.trail) + "`",
          "• Encontros incidentais: `" + String(latest.incidental) + "`",
          "• Encontros diretos: `" + String(latest.direct) + "`",
          "",
          ...(latest.endReason === "BLACKOUT"
            ? [
                "> _Derrota total: sem prêmio de conclusão._",
                ...(latest.blackoutNeedsStaff
                  ? ["Não há resgate disponível. Procure a equipe."]
                  : []),
              ]
            : ["> _Relatório externo (mínimo 100 palavras) e premiação dependem da equipe._"]),
          "› _Este resumo não confirma capturas, batalhas vencidas, itens ou prêmios._",
        ].join("\n"),
      );
    }
    if (searchFree && this.deps.search?.recover !== undefined) {
      const recovered = await this.deps.search.recover(playerId, context, targetSpeciesSlug);
      if (!recovered.ok) return recovered;
      if (recovered.value !== null) {
        const { transition, outcome, encounterPreview, historical } = recovered.value;
        if (!transition.replayed)
          return err(appError("FLOW_BLOCKED", "Resultado da busca sem recibo de recuperação."));
        const panel = renderExpeditionV4SearchResultPanel({
          kind: outcome.kind,
          ...(targetSpeciesSlug === undefined ? {} : { targetSpeciesSlug }),
          encounterPreview,
          historical: historical ?? false,
          elapsedMinutes: transition.expedition.elapsedMinutes,
          consumedWeeklySlot: transition.consumedWeeklySlot,
          canFollowTrail: this.deps.trail !== undefined,
        });
        if (!panel.ok) return panel;
        return privateSearchResult(context, panel.value, playerId, outcome, !historical);
      }
    }
    if (trailRequested && this.deps.trailRecovery !== undefined) {
      const recovered = await this.deps.trailRecovery.resolve({ playerId, context });
      if (!recovered.ok) return recovered;
      if (recovered.value !== null) {
        const shown = renderExpeditionV4TrailFollowPanel({
          encounterPreview: recovered.value.encounterPreview,
          elapsedMinutes: recovered.value.elapsedMinutes,
          consumedWeeklySlot: recovered.value.consumedWeeklySlot,
        });
        if (!shown.ok) return shown;
        return privateSearchResult(
          context,
          recovered.value.historical
            ? shown.value + "\n\nEsse encontro já foi encerrado."
            : shown.value,
          playerId,
          recovered.value.outcome,
          !recovered.value.historical,
        );
      }
    }
    if (travelRequested !== null && this.deps.travelRecovery !== undefined) {
      const committed = await this.deps.travelRecovery.resolve({ playerId, context });
      if (!committed.ok) return committed;
      if (committed.value !== null) return privateTravelConfirmation(context, committed.value);
    }
    if (
      (resourceFree || token === "2") &&
      this.deps.resources !== undefined &&
      this.deps.resourceRecovery !== undefined
    ) {
      const recovered = await this.deps.resourceRecovery.resolve({ playerId, context });
      if (!recovered.ok) return recovered;
      if (recovered.value !== null) {
        return privateResourceConfirmation(context, recovered.value);
      }
    }
    // A previous END transaction may have committed before Inbox completion.
    // Recover only the exact original message/receipt, before a now-ended
    // expedition disappears from the active status reader.
    if (endConfirmed && this.deps.endRecovery !== undefined) {
      const previous = await this.deps.endRecovery.resolve({ playerId, context });
      if (!previous.ok) return previous;
      if (previous.value !== null) {
        return privateEndConfirmation(context, previous.value.elapsedMinutes);
      }
    }
    if (
      ((trailRequested && this.deps.trailRecovery !== undefined) ||
        (travelRequested !== null && this.deps.travelRecovery !== undefined) ||
        ((resourceFree || token === "2") && this.deps.resourceRecovery !== undefined) ||
        (endConfirmed && this.deps.endRecovery !== undefined)) &&
      (await this.deps.facts.isRetry?.(context))
    ) {
      return err(
        appError("FLOW_BLOCKED", "Expedition retry has no committed receipt", {
          userMessage: "Ação não confirmada. Consulte /explorar status.",
        }),
      );
    }
    const located = await this.deps.world.getLocation(playerId);
    if (!located.ok) return located;
    const location = safeLabel(located.value.areaDisplayName);
    if (
      location === null ||
      located.value.playerId !== playerId ||
      located.value.requiresRelocation
    ) {
      return err(appError("FLOW_BLOCKED", "Localização atual não está pronta para a exploração."));
    }
    // The PREPARING writer currently permits only the two published
    // Zhoulia launch areas; do not advertise a period option elsewhere.
    if (
      this.deps.preparation !== undefined &&
      (located.value.regionSlug !== "zhoulia" ||
        !["vila-dos-arrozais", "campos-de-yun"].includes(located.value.areaSlug))
    ) {
      return err(appError("FLOW_BLOCKED", "Esta área ainda não permite preparar uma expedição."));
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
    const weekKey = expeditionWeekKey(this.deps.clock.now(), this.deps.timeZone);
    const currentNavigation = {
      expeditionId: facts.expedition?.expeditionId ?? null,
      revision: facts.expedition?.revision.toString() ?? null,
      areaId: located.value.areaId,
      weekKey,
    };
    const authorized = context.expeditionNavigationAuthorization;
    if (
      authorized &&
      (authorized.expeditionId !== currentNavigation.expeditionId ||
        authorized.revision !== currentNavigation.revision ||
        authorized.areaId !== currentNavigation.areaId ||
        authorized.weekKey !== weekKey)
    )
      return err(
        appError("REVISION_CONFLICT", "Esse menu ficou desatualizado. Consulte /explorar status."),
      );
    const navigation = (
      text: string,
      commands: Readonly<Record<string, string>>,
    ): Result<MessageHandlerResult> => {
      const result = privateText(context, text);
      if (!result.ok) return result;
      return ok({
        ...result.value,
        outgoing: result.value.outgoing.map((message) => ({
          ...message,
          payload: {
            ...message.payload,
            expeditionNavigation: {
              ...currentNavigation,
              originChat: context.message.chatRef,
              playerId,
              commands,
            },
          },
        })),
      });
    };
    if (changePeriodRequested) {
      if (state !== "PREPARING")
        return err(appError("FLOW_BLOCKED", "O período só pode mudar durante a preparação."));
      return navigation(
        "◇ *𝗔𝗟𝗧𝗘𝗥𝗔𝗥 𝗣𝗘𝗥Í𝗢𝗗𝗢*\n\n1. ☀️ Diurno\n2. 🌙 Noturno\n\n> _A preparação permanece gratuita._",
        { "1": "/explorar periodo dia", "2": "/explorar periodo noite" },
      );
    }
    if (helpRequested) {
      const choices = [
        "› _Consulte o estado: /explorar status ou /explorar retomar._",
        ...(state === "NONE" && this.deps.preparation !== undefined && quota.canPrepare
          ? [
              "1. ☀️ Diurno ● /explorar 1",
              "2. 🌙 Noturno ● /explorar 2",
              "› _Preparar não consome tempo nem cota semanal._",
            ]
          : []),
        ...(state !== "NONE" && this.deps.search !== undefined
          ? [
              "1. 🔎 Buscar Pokémon ● `30 min`",
              "› _Use /explorar 1 ou /explorar buscar. Alvo conhecido: /explorar buscar <espécie>._",
            ]
          : []),
        ...(state === "ACTIVE" && this.deps.trail !== undefined
          ? ["› _Seguir rastros recentes: /explorar seguir ● `15 min` (somente se houver rastro)._"]
          : []),
        ...(state !== "NONE" && this.deps.resources !== undefined
          ? [
              "2. 🎒 Buscar recursos ● `60 min`",
              "› _Use /explorar 2 ou /explorar recursos; exige tabela publicada._",
            ]
          : []),
        ...(state !== "NONE" && this.deps.preparation !== undefined
          ? ["3. 🗺️ Consultar destinos ● /explorar 3"]
          : []),
        ...(state === "ACTIVE" && this.deps.search !== undefined
          ? ["4. 📋 Encerrar ● /explorar 4", "› _A confirmação é obrigatória._"]
          : []),
        ...(state === "PREPARING" && this.deps.preparation !== undefined
          ? [
              "› _Trocar período: /explorar periodo dia ou /explorar periodo noite._",
              "› _Cancelar sem custo: /explorar cancelar._",
            ]
          : []),
        ...(this.deps.history !== undefined
          ? ["› _Histórico de eventos: /explorar eventos (consultas gratuitas)._"]
          : []),
        ...(this.deps.summary === undefined
          ? ["› _Histórico ainda não está disponível nesta prévia._"]
          : ["› _Resumo da última expedição concluída: /explorar resumo._"]),
        ...(this.deps.travel === undefined
          ? ["› _Recursos e viagem ainda não estão habilitados nesta versão isolada._"]
          : [
              "› _Viagem somente por conexão com minutos publicados; recursos ainda indisponíveis._",
            ]),
      ];
      return privateText(context, ["✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗔𝗝𝗨𝗗𝗔*", "", ...choices].join("\n"));
    }
    if (destinationsRequested && this.deps.preparation !== undefined) {
      if (state === "NONE") {
        return err(
          appError("FLOW_BLOCKED", "Prepare an expedition before consulting destinations"),
        );
      }
      return privateExpeditionDestinations(context, located.value, this.deps.travel !== undefined);
    }
    if (travelRequested !== null && this.deps.travel !== undefined) {
      if (!expeditionOperationAllowed(playerId) || facts.expedition === null) {
        return err(appError("FLOW_BLOCKED", "Travel requires isolated prepared expedition"));
      }
      const slug = travelRequested[1]?.toLowerCase();
      const road = located.value.connections.find(
        (connection) =>
          connection.available &&
          connection.missingUnlockKeys.length === 0 &&
          connection.destinationSlug === slug &&
          Number.isSafeInteger(connection.explorationMinutes) &&
          connection.explorationMinutes !== undefined &&
          connection.explorationMinutes > 0 &&
          connection.explorationMinutes <= EXPEDITION_DURATION_MINUTES,
      );
      if (road === undefined || road.destinationAreaId === located.value.areaId) {
        return err(appError("FLOW_BLOCKED", "No approved expedition travel cost for destination"));
      }
      if (safeLabel(road.destinationDisplayName) === null) {
        return err(appError("FLOW_BLOCKED", "Travel destination name is unsafe"));
      }
      const original = facts.expedition;
      const moved = await this.deps.travel.execute({
        playerId,
        expeditionId: original.expeditionId,
        expectedRevision: original.revision,
        expectedWorldRevision: located.value.revision,
        destinationAreaId: road.destinationAreaId,
        idempotencyKey: context.idempotencyKey,
      });
      if (!moved.ok) return moved;
      const after = moved.value.expedition;
      if (
        after.playerId !== playerId ||
        after.expeditionId !== original.expeditionId ||
        after.areaId !== road.destinationAreaId ||
        after.elapsedMinutes !== original.elapsedMinutes + road.explorationMinutes! ||
        after.revision !== original.revision + 1n ||
        moved.value.consumedWeeklySlot !== (state === "PREPARING")
      ) {
        return err(appError("FLOW_BLOCKED", "Travel receipt was inconsistent with the expedition"));
      }
      return privateTravelConfirmation(context, {
        destinationDisplayName: road.destinationDisplayName,
        travelMinutes: road.explorationMinutes!,
        elapsedMinutes: after.elapsedMinutes,
        phase: after.phase === "ENDED" ? "ENDED" : "ACTIVE",
      });
    }
    if ((endRequested || endConfirmed) && this.deps.search !== undefined) {
      const current = facts.expedition;
      if (current === null || state !== "ACTIVE" || this.deps.preparation === undefined) {
        return err(appError("FLOW_BLOCKED", "No active expedition is available to close"));
      }
      if (endRequested) {
        return privateText(
          context,
          [
            "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗖𝗢𝗡𝗙𝗜𝗥𝗠𝗔ÇÃ𝗢*",
            "> _Deseja realmente encerrar a expedição atual?_",
            "",
            "⌛ *Tempo utilizado:* `" + String(current.elapsedMinutes) + " min`",
            "🎟️ *A cota já consumida não será devolvida.*",
            "",
            "› _Para confirmar: /explorar encerrar confirmar_",
            "› _Para continuar explorando, não envie essa confirmação._",
          ].join("\n"),
        );
      }
      if (!expeditionOperationAllowed(playerId)) {
        return err(appError("FLOW_BLOCKED", "Closure is only enabled in isolated development"));
      }
      const ended = await this.deps.preparation.end({
        playerId,
        expeditionId: current.expeditionId,
        expectedRevision: current.revision,
        reason: "VOLUNTARY",
        idempotencyKey: context.idempotencyKey,
      });
      if (!ended.ok) return ended;
      if (
        ended.value.expedition.playerId !== playerId ||
        ended.value.expedition.expeditionId !== current.expeditionId ||
        ended.value.expedition.areaId !== located.value.areaId ||
        ended.value.expedition.phase !== "ENDED" ||
        ended.value.expedition.endReason !== "VOLUNTARY" ||
        ended.value.expedition.revision !== current.revision + 1n ||
        ended.value.expedition.elapsedMinutes !== current.elapsedMinutes ||
        ended.value.expedition.consumedWeekKey !== current.consumedWeekKey ||
        ended.value.consumedWeeklySlot
      ) {
        return err(appError("FLOW_BLOCKED", "Voluntary closure did not match the expedition"));
      }
      return privateEndConfirmation(context, current.elapsedMinutes);
    }
    // A numeric option is contextual, not a second day-preparation command:
    // in NONE, /explorar 1 selects day; in PREPARING/ACTIVE, /explorar 1
    // is SEARCH_FREE only when the real search writer is configured.
    const searchRequested =
      searchFree || (this.deps.search !== undefined && token === "1" && state !== "NONE");
    if (searchRequested && this.deps.search !== undefined) {
      const current = facts.expedition;
      if (current === null || (current.phase !== "PREPARING" && current.phase !== "ACTIVE")) {
        return err(appError("FLOW_BLOCKED", "Não há expedição para buscar nesta área."));
      }
      const committed = await this.deps.search.execute({
        ...(targetSpeciesSlug === undefined ? {} : { targetSpeciesSlug }),
        playerId,
        expeditionId: current.expeditionId,
        expectedRevision: current.revision,
        idempotencyKey: context.idempotencyKey,
      });
      if (!committed.ok) return committed;
      const { transition, outcome } = committed.value;
      if (
        transition.expedition.expeditionId !== current.expeditionId ||
        transition.expedition.playerId !== playerId ||
        transition.expedition.areaId !== located.value.areaId ||
        outcome.playerId !== playerId ||
        outcome.expeditionId !== current.expeditionId ||
        outcome.expeditionRevision !== current.revision ||
        transition.expedition.elapsedMinutes !== current.elapsedMinutes + 30 ||
        (current.phase === "PREPARING" && !transition.consumedWeeklySlot) ||
        (current.phase === "ACTIVE" && transition.consumedWeeklySlot)
      ) {
        return err(appError("FLOW_BLOCKED", "O resultado da busca não corresponde à expedição."));
      }
      const panel = renderExpeditionV4SearchResultPanel({
        kind: outcome.kind,
        ...(targetSpeciesSlug === undefined ? {} : { targetSpeciesSlug }),
        encounterPreview: committed.value.encounterPreview,
        historical: committed.value.historical ?? false,
        elapsedMinutes: transition.expedition.elapsedMinutes,
        consumedWeeklySlot: transition.consumedWeeklySlot,
        canFollowTrail: this.deps.trail !== undefined,
      });
      if (!panel.ok) return panel;
      return privateSearchResult(
        context,
        panel.value,
        playerId,
        outcome,
        !committed.value.historical,
      );
    }
    if (trailRequested && this.deps.trail !== undefined) {
      const current = facts.expedition;
      if (current === null || current.phase !== "ACTIVE") {
        return err(appError("FLOW_BLOCKED", "Não há rastros de uma expedição ativa."));
      }
      const sourceOutcomeId = await this.deps.trail.readPending(current);
      if (sourceOutcomeId === null) {
        return err(appError("FLOW_BLOCKED", "Nenhum rastro recente pode ser seguido agora."));
      }
      const followed = await this.deps.trail.execute({
        playerId,
        expeditionId: current.expeditionId,
        expectedRevision: current.revision,
        idempotencyKey: context.idempotencyKey,
        sourceOutcomeId,
      });
      if (!followed.ok) return followed;
      const { transition, outcome } = followed.value;
      if (
        transition.expedition.playerId !== playerId ||
        transition.expedition.expeditionId !== current.expeditionId ||
        transition.expedition.areaId !== located.value.areaId ||
        transition.expedition.revision !== current.revision + 1n ||
        transition.expedition.elapsedMinutes !== current.elapsedMinutes + 15 ||
        transition.consumedWeeklySlot ||
        followed.value.sourceOutcomeId !== sourceOutcomeId ||
        outcome.kind !== "DIRECT" ||
        outcome.encounterId === null ||
        outcome.playerId !== playerId ||
        outcome.expeditionId !== current.expeditionId ||
        outcome.expeditionRevision !== current.revision
      ) {
        return err(appError("FLOW_BLOCKED", "O encontro do rastro não corresponde à expedição."));
      }
      const panel = renderExpeditionV4TrailFollowPanel({
        encounterPreview: followed.value.encounterPreview,
        elapsedMinutes: transition.expedition.elapsedMinutes,
        consumedWeeklySlot: transition.consumedWeeklySlot,
      });
      if (!panel.ok) return panel;
      return privateSearchResult(context, panel.value, playerId, outcome);
    }
    // The contextual 2 is a resource search ONLY in PREPARING/ACTIVE.
    // In NONE it remains the existing night-preparation choice.
    const resourcesRequested =
      resourceFree || (this.deps.resources !== undefined && token === "2" && state !== "NONE");
    if (resourcesRequested && this.deps.resources !== undefined) {
      const current = facts.expedition;
      if (current === null || !["PREPARING", "ACTIVE"].includes(current.phase)) {
        return err(appError("FLOW_BLOCKED", "Prepare uma expedição antes de procurar recursos."));
      }
      const committed = await this.deps.resources.execute({
        playerId,
        expeditionId: current.expeditionId,
        expectedRevision: current.revision,
        idempotencyKey: context.idempotencyKey,
      });
      if (!committed.ok) return committed;
      const { transition, resource } = committed.value;
      if (
        transition.expedition.playerId !== playerId ||
        transition.expedition.expeditionId !== current.expeditionId ||
        transition.expedition.areaId !== located.value.areaId ||
        transition.expedition.elapsedMinutes !== current.elapsedMinutes + 60 ||
        resource.playerId !== playerId ||
        resource.expeditionId !== current.expeditionId ||
        resource.expeditionRevision !== current.revision ||
        (current.phase === "PREPARING" && !transition.consumedWeeklySlot) ||
        (current.phase === "ACTIVE" && transition.consumedWeeklySlot)
      ) {
        return err(appError("FLOW_BLOCKED", "Recibo de recursos não corresponde à expedição."));
      }
      return privateResourceConfirmation(context, {
        kind: resource.kind,
        displayName: resource.displayName,
        quantity: resource.quantity,
        elapsedMinutes: transition.expedition.elapsedMinutes,
        consumedWeeklySlot: transition.consumedWeeklySlot,
      });
    }
    if ((requestedPeriod !== null || cancel) && this.deps.preparation !== undefined) {
      // This stage-only command is valid solely against the persisted PREPARING
      // row. A stale ACTIVE, ENDED or absent expedition cannot be edited.
      const current = facts.expedition;
      if (current === null || current.phase !== "PREPARING") {
        return err(appError("FLOW_BLOCKED", "Não há preparação ativa para alterar ou cancelar."));
      }
      const result =
        requestedPeriod === null
          ? await this.deps.preparation.end({
              playerId,
              expeditionId: current.expeditionId,
              expectedRevision: current.revision,
              reason: "CANCELLED",
              idempotencyKey: context.idempotencyKey,
            })
          : await this.deps.preparation.changePeriod({
              playerId,
              expeditionId: current.expeditionId,
              expectedRevision: current.revision,
              period: requestedPeriod,
              idempotencyKey: context.idempotencyKey,
            });
      if (!result.ok) return result;
      const changed = result.value.expedition;
      if (
        changed.playerId !== playerId ||
        changed.expeditionId !== current.expeditionId ||
        changed.areaId !== located.value.areaId ||
        result.value.consumedWeeklySlot ||
        changed.elapsedMinutes !== 0 ||
        changed.consumedWeekKey !== null ||
        (requestedPeriod === null
          ? changed.phase !== "ENDED" || changed.endReason !== "CANCELLED"
          : changed.phase !== "PREPARING" ||
            changed.period !== requestedPeriod ||
            changed.endReason !== null)
      ) {
        return err(appError("FLOW_BLOCKED", "O resultado da preparação é inconsistente."));
      }
      if (requestedPeriod !== null && this.deps.search !== undefined) {
        const { expeditionNavigationAuthorization: _authorization, ...display } = context;
        return this.handle({
          ...display,
          message: { ...context.message, text: "/explorar status" },
        });
      }
      return privateText(
        context,
        [
          "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
          requestedPeriod === null
            ? "◇ *Preparação cancelada!*"
            : requestedPeriod === "DAY"
              ? "☀️ *Período alterado para Diurno*"
              : "🌙 *Período alterado para Noturno*",
          "",
          "*🎟️ Nenhuma cota consumida*",
          "*⌛ Nenhum minuto consumido*",
          "",
          ...(requestedPeriod !== null && this.deps.search !== undefined
            ? [
                "1. 🔎 Buscar Pokémon ● `30 min`",
                "› _Para buscar: /explorar 1 ou /explorar buscar._",
              ]
            : ["> _As ações de busca e captura continuam desativadas nesta prévia._"]),
          "› _Use /explorar status para consultar a situação._",
        ].join("\n"),
      );
    }
    if (period !== null && this.deps.preparation !== undefined) {
      if (state !== "NONE") {
        return err(
          appError("FLOW_BLOCKED", "This period choice is no longer the current expedition menu"),
        );
      }
      // The canonical repo owns locks, World release, weekly quota and
      // idempotency. We never grant resources or advance expedition time here.
      const result = await this.deps.preparation.prepare({
        playerId,
        period,
        idempotencyKey: context.idempotencyKey,
      });
      if (!result.ok) return result;
      const expedition = result.value.expedition;
      if (
        expedition.playerId !== playerId ||
        expedition.areaId !== located.value.areaId ||
        expedition.period !== period ||
        expedition.phase !== "PREPARING" ||
        expedition.elapsedMinutes !== 0 ||
        expedition.consumedWeekKey !== null ||
        expedition.endReason !== null
      ) {
        return err(
          appError("FLOW_BLOCKED", "Persisted preparation disagrees with the canonical World"),
        );
      }
      if (this.deps.search !== undefined) {
        const { expeditionNavigationAuthorization: _authorization, ...display } = context;
        return this.handle({
          ...display,
          message: { ...context.message, text: "/explorar status" },
        });
      }
      return privateText(
        context,
        [
          "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
          "> _Exploração " + (period === "DAY" ? "diurna" : "noturna") + " preparada!_",
          "",
          period === "DAY" ? "☀️ 06:00 → 18:00" : "🌙 18:00 → 06:00",
          "⌖ *" + location + "*",
          "*⌛ 12h* disponíveis",
          "*🎟️ Cota ainda não consumida*",
          "",
          ...(this.deps.search === undefined
            ? ["> _Prévia de preparação: buscas, captura e viagem continuam desativadas._"]
            : [
                "◇ *𝗔ÇÕ𝗘𝗦*",
                "1. 🔎 Buscar Pokémon ● `30 min`",
                "› _Use /explorar 1 ou /explorar buscar para iniciar a busca._",
                ...(this.deps.resources === undefined
                  ? ["› _Recursos indisponíveis._"]
                  : [
                      "2. 🎒 Buscar recursos ● `60 min`",
                      "› _/explorar 2 ou /explorar recursos; somente com tabela publicada._",
                    ]),
                "› _Viagem exige conexão e duração publicada._",
              ]),
          "3. 🗺️ Consultar destinos ● /explorar 3",
          "› _Use /explorar status para consultar a expedição._",
        ].join("\n"),
      );
    }
    if (this.deps.preparation !== undefined && state === "NONE" && quota.canPrepare) {
      const opening = renderExpeditionV4OpeningPanel({
        phase: "NONE",
        locationName: location,
        remainingThisWeek: quota.remaining,
        canPrepareUnderPolicy: true,
        choices: [
          { optionNo: 1, intent: "PREPARE_DAY", label: "☀️ Diurno", phrases: [] },
          { optionNo: 2, intent: "PREPARE_NIGHT", label: "🌙 Noturno", phrases: [] },
        ],
      });
      if (!opening.ok) return opening;
      if (this.deps.search !== undefined)
        return navigation(opening.value.text, { "1": "/explorar dia", "2": "/explorar noite" });
      return privateText(
        context,
        [
          opening.value.text,
          "",
          "› _Prévia de preparação: envie /explorar 1 ou /explorar 2._",
          ...(this.deps.search === undefined
            ? ["› _Busca, viagem e captura ainda não estão liberadas._"]
            : [
                "› _Prepare um período para liberar a busca; recursos e viagem seguem indisponíveis._",
              ]),
        ].join("\n"),
      );
    }
    // Render the approved V4 state hierarchy only when the canonical search
    // service is actually wired. Non-existent resource/travel/end actions are
    // not offered. Until device calibration, display every action accessibly
    // with combiningCount=0 instead of faking the native WhatsApp fold.
    if (this.deps.search !== undefined && facts.expedition !== null) {
      if (state === "PREPARING") {
        const current = facts.expedition;
        const shown = renderExpeditionV4PreparingPanel({
          expedition: current,
          locationName: location,
          remainingThisWeek: quota.remaining,
          choices: [
            {
              optionNo: 1,
              intent: "SEARCH_FREE",
              label: "🔎 Buscar Pokémon ● 30 min",
              phrases: [],
            },
            ...(this.deps.resources === undefined
              ? []
              : [
                  {
                    optionNo: 2,
                    intent: "SEARCH_RESOURCES" as const,
                    label: "🎒 Buscar recursos ● 60 min",
                    phrases: [],
                  },
                ]),
            {
              optionNo: 3,
              intent: "DESTINATIONS",
              label: "🗺️ Consultar destinos",
              phrases: [],
            },
            { optionNo: 4, intent: "CHANGE_PERIOD", label: "🔄 Alterar período", phrases: [] },
            {
              optionNo: 5,
              intent: "CANCEL_PREPARATION",
              label: "↩️ Cancelar preparação",
              phrases: [],
            },
          ],
          combiningCount: this.deps.combiningCount ?? 0,
        });
        if (!shown.ok) return shown;
        return navigation(shown.value.text, {
          "1": "/explorar buscar",
          ...(this.deps.resources ? { "2": "/explorar recursos" } : {}),
          "3": "/explorar destinos",
          "4": "/explorar alterar",
          "5": "/explorar cancelar",
        });
      }
      const clock = expeditionClock(facts.expedition.period, facts.expedition.elapsedMinutes);
      const shown = renderExpeditionV4ActivePanel({
        phase: "ACTIVE",
        period: facts.expedition.period,
        currentTime: clock.currentTime,
        elapsedMinutes: facts.expedition.elapsedMinutes,
        choices: [
          {
            optionNo: 1,
            intent: "SEARCH_FREE",
            label: "🔎 Buscar Pokémon ● 30 min",
            phrases: [],
          },
          ...(this.deps.resources === undefined
            ? []
            : [
                {
                  optionNo: 2,
                  intent: "SEARCH_RESOURCES" as const,
                  label: "🎒 Buscar recursos ● 60 min",
                  phrases: [],
                },
              ]),
          {
            optionNo: 3,
            intent: "DESTINATIONS",
            label: "🗺️ Consultar destinos",
            phrases: [],
          },
          {
            optionNo: 4,
            intent: "END",
            label: "📋 Encerrar",
            phrases: [],
          },
        ],
        combiningCount: this.deps.combiningCount ?? 0,
      });
      if (!shown.ok) return shown;
      return navigation(shown.value.text, {
        "1": "/explorar buscar",
        ...(this.deps.resources ? { "2": "/explorar recursos" } : {}),
        "3": "/explorar destinos",
        "4": "/explorar encerrar",
      });
    }
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
      if (state === "PREPARING") {
        lines.push("⌛ *Cota ainda não consumida*");
        if (this.deps.preparation !== undefined) {
          lines.push("◇ *Ajustes gratuitos:* /explorar periodo dia · /explorar periodo noite");
          lines.push("◇ *Desistir:* /explorar cancelar");
        }
      }
    }
    if (this.deps.search !== undefined && facts.expedition !== null) {
      lines.push("◇ *Busca em staging:* /explorar buscar · consome 30min");
    }
    lines.push(
      "",
      this.deps.search === undefined
        ? "> _Consulta sem custo. Buscar, viajar, capturar ou preparar não estão disponíveis nesta prévia._"
        : "> _Consulta sem custo. A busca consome tempo e a primeira cota; captura, recursos e viagem continuam bloqueados._",
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
      // Explicitly discard any accidentally supplied write capability.
      handler: new ExpeditionV4ReadOnlyHandler({
        players: deps.players,
        world: deps.world,
        facts: deps.facts,
        group: deps.group,
        clock: deps.clock,
        timeZone: deps.timeZone,
      }),
      rateLimitClass: "SENSITIVE",
      policy: {
        requiredGroupCapabilities: ["world", "player.basic"],
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    },
  ];
}

/**
 * Isolated staging only. This is intentionally a separate factory to keep
 * production/read-only callers unable to accidentally inherit write ports.
 * No capture, resources, travel, time consumption or player rewards exist here.
 */
export function createExpeditionV4StagingPreparationRoutes(
  deps: ExpeditionV4ReadOnlyDeps & {
    readonly preparation: Pick<PostgresExpeditionRepository, "prepare" | "changePeriod" | "end">;
  },
): readonly CommandRouteDefinition[] {
  return [
    {
      command: "explorar",
      // A preparing-only route must not inherit any search port at runtime.
      handler: new ExpeditionV4ReadOnlyHandler({
        players: deps.players,
        world: deps.world,
        facts: deps.facts,
        group: deps.group,
        clock: deps.clock,
        timeZone: deps.timeZone,
        preparation: deps.preparation,
      }),
      rateLimitClass: "SENSITIVE",
      policy: {
        requiredGroupCapabilities: ["world", "player.basic"],
        allowedPlayerAccess: ["ACTIVE"],
        requiresMechanicalReady: true,
      },
    },
  ];
}

export function createExpeditionV4StagingSearchRoutes(
  deps: ExpeditionV4ReadOnlyDeps & {
    readonly preparation: Pick<PostgresExpeditionRepository, "prepare" | "changePeriod" | "end">;
    readonly search: Pick<PostgresExpeditionV4StagingSearch, "execute"> &
      Partial<Pick<PostgresExpeditionV4StagingSearch, "recover">>;
  },
): readonly CommandRouteDefinition[] {
  return [
    {
      command: "explorar",
      handler: new ExpeditionV4ReadOnlyHandler(deps),
      rateLimitClass: "SENSITIVE",
      policyForContext: (context) =>
        deps.reports && /^\/explorar\s+revisar(?:\s|$)/iu.test(context.message.text ?? "")
          ? {
              requiredGroupCapabilities: ["world", "player.basic"],
              requiredAdminCapability: "reward.grant",
            }
          : {
              requiredGroupCapabilities: ["world", "player.basic"],
              allowedPlayerAccess: ["ACTIVE"],
              requiresMechanicalReady: true,
            },
    },
  ];
}
