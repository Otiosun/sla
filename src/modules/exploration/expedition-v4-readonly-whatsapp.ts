import type { Clock } from "../../platform/clock/index.js";
import type { PostgresExpeditionRepository } from "../../platform/exploration/postgres-expedition-repository.js";
import type { PostgresExpeditionV4StagingSearch } from "../../platform/exploration/postgres-expedition-v4-search.js";
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
import { renderExpeditionV4OpeningPanel } from "./expedition-v4-preparation-panel.js";

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
    if (
      !/^\/explorar(?:\s+(?:status|retomar))?$/iu.test(text) &&
      ((this.deps.preparation === undefined ||
        (period === null && requestedPeriod === null && !cancel)) &&
        (!searchFree || this.deps.search === undefined))
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
    const located = await this.deps.world.getLocation(playerId);
    if (!located.ok) return located;
    const location = safeLabel(located.value.areaDisplayName);
    if (location === null || located.value.requiresRelocation) {
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
    if (searchFree && this.deps.search !== undefined) {
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
      // No invented species, loot or trail UX. Do not offer unfinished
      // capture/battle actions even when a canonical Encounter is stored.
      const description = {
        NO_SIGNAL: "Nenhum sinal de Pokémon foi registrado.",
        TRAIL: "Um rastro foi registrado. Seguir rastros ainda não está disponível nesta prévia.",
        INCIDENTAL: "Encontro incidental registrado. A interação com o Pokémon ainda está bloqueada na prévia.",
        DIRECT: "Encontro direto registrado. A interação com o Pokémon ainda está bloqueada na prévia.",
      }[outcome.kind];
      if (!description) return err(appError("FLOW_BLOCKED", "Resultado de busca desconhecido."));
      return privateText(context, [
        "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗕𝗨𝗦𝗖𝗔*",
        description,
        "",
        "⌛ *30min consumidos na expedição*",
        transition.consumedWeeklySlot ? "🎟️ *Primeira cota semanal utilizada*" : "🎟️ *Nenhuma cota adicional utilizada*",
        "",
        "> _Resultado salvo no banco isolado de staging. Nenhuma recompensa inventada._",
        "› _Use /explorar status para consultar o tempo restante._",
      ].join("\n"));
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
          "> _As ações de busca e captura continuam desativadas nesta prévia._",
          "› _Use /explorar status para consultar a situação._",
        ].join("\n"),
      );
    }
    if (period !== null && this.deps.preparation !== undefined) {
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
          "> _Prévia de preparação: buscas, captura e viagem continuam desativadas._",
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
          "› _Busca, viagem e captura ainda não estão liberadas._",
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

export function createExpeditionV4StagingSearchRoutes(
  deps: ExpeditionV4ReadOnlyDeps & {
    readonly preparation: Pick<PostgresExpeditionRepository, "prepare" | "changePeriod" | "end">;
    readonly search: Pick<PostgresExpeditionV4StagingSearch, "execute">;
  },
): readonly CommandRouteDefinition[] {
  return [{
    command: "explorar",
    handler: new ExpeditionV4ReadOnlyHandler(deps),
    rateLimitClass: "SENSITIVE",
    policy: {
      requiredGroupCapabilities: ["world", "player.basic"],
      allowedPlayerAccess: ["ACTIVE"],
      requiresMechanicalReady: true,
    },
  }];
}
