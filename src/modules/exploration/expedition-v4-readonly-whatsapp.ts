import type { Clock } from "../../platform/clock/index.js";
import type { PostgresExpeditionRepository } from "../../platform/exploration/postgres-expedition-repository.js";
import type { PostgresExpeditionEndConfirmationRecovery } from "../../platform/exploration/postgres-expedition-end-confirmation-recovery.js";
import type { PostgresExpeditionV4StatusReader } from "../../platform/exploration/postgres-expedition-v4-status-reader.js";
import type { PostgresExpeditionV4StagingSearch } from "../../platform/exploration/postgres-expedition-v4-search.js";
import type { StoredSearchOutcome } from "../../platform/exploration/expedition-search-outcome-effect.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { WorldLocationView } from "../world/contracts.js";
import {
  EXPEDITION_DURATION_MINUTES,
  EXPEDITION_WEEKLY_LIMIT,
  expeditionClock,
} from "./expedition-clock.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";
import { expeditionWeekKey, expeditionWeeklyAdmission } from "./expedition-week.js";
import {
  renderExpeditionV4OpeningPanel,
  renderExpeditionV4PreparingPanel,
} from "./expedition-v4-preparation-panel.js";
import { renderExpeditionV4ActivePanel } from "./expedition-v4-active-panel.js";
import { renderExpeditionV4SearchResultPanel } from "./expedition-v4-search-result-panel.js";

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
  /** Staging-only: omitted for the existing truly read-only route. */
  readonly preparation?: Pick<PostgresExpeditionRepository, "prepare" | "changePeriod" | "end">;
  /** Third explicit stage-only opt-in. No encounter route exists without it. */
  readonly search?: Pick<PostgresExpeditionV4StagingSearch, "execute">;
  /** Test-only recovery of a committed END when Inbox completion was interrupted. */
  readonly endRecovery?: Pick<PostgresExpeditionEndConfirmationRecovery, "resolve">;
  /** Isolated read-only summary; never fabricates capture, XP or item grants. */
  readonly summary?: Pick<PostgresExpeditionV4StatusReader, "readLatestCompleted">;
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
    outgoing: base.value.outgoing.map((message) => ({
      ...message,
      payload: {
        ...message.payload,
        expeditionSearch: {
          playerId,
          outcomeId: outcome.outcomeId,
          encounterId: outcome.encounterId,
        },
      },
    })),
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
    destinations.push("• " + label);
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
      "› _O deslocamento ainda não está disponível nesta prévia._",
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

class ExpeditionV4ReadOnlyHandler implements MessageRouteHandler {
  public constructor(private readonly deps: ExpeditionV4ReadOnlyDeps) {
    // The configured calendar must be validated even if no trainer calls the command.
    expeditionWeekKey(deps.clock.now(), deps.timeZone);
  }

  public async handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    const text = context.message.text?.trim() ?? "";
    // Bare "1"/"2" require a durable menu reference and are not accepted.
    const match = /^\/explorar\s+(?:preparar\s+)?(dia|noite|1|2)$/iu.exec(text);
    const token = match?.[1]?.toLocaleLowerCase("pt-BR");
    const period =
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
    const searchFree = /^\/explorar\s+buscar$/iu.test(text);
    const helpRequested = /^\/explorar\s+ajuda$/iu.test(text);
    const endRequested = /^\/explorar\s+(?:encerrar|4)$/iu.test(text);
    const destinationsRequested = /^\/explorar\s+(?:destinos|3)$/iu.test(text);
    const summaryRequested = /^\/explorar\s+resumo$/iu.test(text);
    const endConfirmed = /^\/explorar\s+encerrar\s+confirmar$/iu.test(text);
    if (
      !/^\/explorar(?:\s+(?:status|retomar|ajuda))?$/iu.test(text) &&
      (this.deps.preparation === undefined ||
        (period === null && requestedPeriod === null && !cancel)) &&
      (!searchFree || this.deps.search === undefined) &&
      (!(endRequested || endConfirmed) || this.deps.search === undefined) &&
      (!destinationsRequested || this.deps.preparation === undefined) &&
      (!summaryRequested || this.deps.summary === undefined)
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
            ? ["> _Derrota total: sem prêmio de conclusão._"]
            : ["> _Relatório externo (mínimo 100 palavras) e premiação dependem da equipe._"]),
          "› _Este resumo não confirma capturas, batalhas vencidas, itens ou prêmios._",
        ].join("\n"),
      );
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
          ? ["1. 🔎 Buscar Pokémon ● `30 min`", "› _Use /explorar 1 ou /explorar buscar._"]
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
        ...(this.deps.summary === undefined
          ? ["› _Histórico ainda não está disponível nesta prévia._"]
          : ["› _Resumo da última expedição concluída: /explorar resumo._"]),
        "› _Recursos e viagem ainda não estão habilitados nesta versão isolada._",
      ];
      return privateText(context, ["✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗔𝗝𝗨𝗗𝗔*", "", ...choices].join("\n"));
    }
    if (destinationsRequested && this.deps.preparation !== undefined) {
      if (state === "NONE") {
        return err(
          appError("FLOW_BLOCKED", "Prepare an expedition before consulting destinations"),
        );
      }
      return privateExpeditionDestinations(context, located.value);
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
      if (
        process.env.APP_ENV !== "test" ||
        process.env.NODE_ENV !== "test" ||
        process.env.WHATSAPP_ENABLED !== "false"
      ) {
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
        encounterPreview: committed.value.encounterPreview,
        elapsedMinutes: transition.expedition.elapsedMinutes,
        consumedWeeklySlot: transition.consumedWeeklySlot,
      });
      if (!panel.ok) return panel;
      return privateSearchResult(context, panel.value, playerId, outcome);
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
                "› _Recursos e viagem ainda não estão disponíveis._",
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
            {
              optionNo: 3,
              intent: "DESTINATIONS",
              label: "🗺️ Consultar destinos",
              phrases: [],
            },
          ],
          combiningCount: 0,
        });
        if (!shown.ok) return shown;
        return privateText(
          context,
          [
            shown.value.text,
            "› _Busque: /explorar 1 ou /explorar buscar._",
            "› _Alterar gratuitamente: /explorar periodo dia ou /explorar periodo noite._",
            "› _Cancelar preparação: /explorar cancelar._",
            "3. 🗺️ Consultar destinos",
            "› _Use /explorar 3 ou /explorar destinos, sem gasto._",
            "› _Recursos e viagem ainda não estão disponíveis._",
          ].join("\n"),
        );
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
        combiningCount: 0,
      });
      if (!shown.ok) return shown;
      return privateText(
        context,
        [
          shown.value.text,
          "› _Busque: /explorar 1 ou /explorar buscar._",
          "› _Consultar destinos: /explorar 3 (sem gasto)._",
          "› _Para encerrar: /explorar 4 (exige confirmação)._",
          "› _Recursos e viagem ainda não estão habilitados._",
        ].join("\n"),
      );
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
    readonly search: Pick<PostgresExpeditionV4StagingSearch, "execute">;
  },
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
