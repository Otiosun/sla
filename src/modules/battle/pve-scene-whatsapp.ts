import { type PlayerId, parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CaptureService } from "../capture/service.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { EncounterService } from "../encounter/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { BattleAction, BattleState } from "./contracts.js";
import type {
  BattleParticipantController,
  BattleParticipantControllerRepository,
} from "./participant-controller.js";
import type { BattleRuntimeService } from "./runtime.js";
import { parseSceneAction } from "./scene-action.js";

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;
class FunctionalHandler implements MessageRouteHandler {
  constructor(private readonly fn: Handler) {}
  handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}
export interface PveCaptureBallOption {
  readonly itemId: string;
  readonly displayName: string;
  readonly quantity: bigint;
}

export interface PveCaptureBallReader {
  listAvailable(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PveCaptureBallOption[]>;
}

export interface PveSceneDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly activeBattleId: (playerId: PlayerId) => Promise<string | null>;
  readonly battle: Pick<
    BattleRuntimeService,
    "currentState" | "resolvePlayerTurn" | "surrenderPvp"
  >;
  readonly controllers: Pick<BattleParticipantControllerRepository, "listByBattle" | "transition">;
  readonly encounters?: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly encounterWriter?: Pick<EncounterService, "flee">;
  readonly capture?: Pick<CaptureService, "attempt">;
  readonly captureBalls?: PveCaptureBallReader;
  readonly admins: {
    resolvePrincipal(input: {
      readonly provider: string;
      readonly externalId: string;
    }): Promise<{ readonly principalId: string } | null>;
  };
}
function reply(
  context: MessageHandlerContext,
  text: string,
  battleId: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "BATTLE",
    resultRefId: battleId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:battle`,
      },
    ],
  });
}

function encounterReply(
  context: MessageHandlerContext,
  text: string,
  encounterId: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "ENCOUNTER",
    resultRefId: encounterId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:encounter`,
      },
    ],
  });
}

function actionFrom(
  state: BattleState,
  actorParticipantId: string,
  intent: ReturnType<typeof parseSceneAction>,
): Result<BattleAction> {
  if (intent.kind !== "ACTION")
    return err(appError("VALIDATION_FAILED", "Diretiva de batalha inválida."));
  const actor = state.combatants.find((entry) => entry.participantId === actorParticipantId);
  if (actor === undefined) return err(appError("ACTION_INVALID", "Ator de batalha indisponível."));
  const sides =
    state.sides ??
    [...new Set(state.combatants.map((combatant) => combatant.sideNo))].map((sideNo) => ({
      sideNo,
      activeParticipantId: state.combatants.find((combatant) => combatant.sideNo === sideNo)
        ?.participantId,
      result: null,
    }));
  const targetSide = sides.find((side) => side.sideNo !== actor.sideNo && side.result === null);
  const target =
    targetSide === undefined
      ? undefined
      : state.combatants.find(
          (entry) => entry.participantId === targetSide.activeParticipantId && entry.currentHp > 0,
        );
  switch (intent.intent.type) {
    case "USE_MOVE":
      return target === undefined
        ? err(appError("ACTION_INVALID", "Sem alvo disponível."))
        : ok({
            type: "USE_MOVE",
            actorParticipantId,
            targetParticipantId: target.participantId,
            moveSlot: intent.intent.moveSlot,
          });
    case "FLEE":
      return ok({ type: "FLEE", actorParticipantId });
    case "SURRENDER":
      return err(appError("ACTION_INVALID", "Desistir não é uma ação PVE disponível."));
    default:
      return err(appError("ACTION_INVALID", "Essa diretiva ainda não é uma ação PVE disponível."));
  }
}

function activeController(
  state: BattleState,
  controllers: readonly BattleParticipantController[],
  predicate: (controller: BattleParticipantController) => boolean,
): BattleParticipantController | undefined {
  if (state.sides === undefined || state.sides.length === 0) {
    return controllers.find(predicate);
  }
  const active = new Set(state.sides.map((side) => side.activeParticipantId));
  return controllers.find(
    (controller) => active.has(controller.participantId) && predicate(controller),
  );
}

function activeWildParticipant(state: BattleState) {
  for (const side of state.sides ?? []) {
    const active = state.combatants.find(
      (entry) => entry.participantId === side.activeParticipantId,
    );
    if (active?.participantKind === "WILD_POKEMON") return active;
  }
  return undefined;
}

function normalizeBallName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ");
}

function chooseBall(
  options: readonly PveCaptureBallOption[],
  reference: string,
): PveCaptureBallOption | null {
  if (options.length === 0) return null;
  const normalized = normalizeBallName(reference);
  if (normalized.length === 0) return options.length === 1 ? (options[0] ?? null) : null;
  const matches = options.filter((option) => normalizeBallName(option.displayName) === normalized);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function ballPrompt(options: readonly PveCaptureBallOption[]): string {
  if (options.length === 0) {
    return ["🎒 *SEM POKÉ BOLAS*", "", "_Você não tem uma Poké Bola disponível._"].join("\n");
  }
  return [
    "🎒 *ESCOLHA A POKÉ BOLA*",
    "",
    ...options.map((option) => `• *${option.displayName}* ×${option.quantity.toString()}`),
    "",
    `Use \`/capturar ${options[0]?.displayName ?? "Poké Ball"}\`.`,
  ].join("\n");
}

function statusLabel(status: BattleState["combatants"][number]["majorStatus"]): string {
  return status === null || status === undefined
    ? "sem status"
    : status.key.toLocaleLowerCase("pt-BR");
}

function hud(
  state: BattleState,
  controller: { readonly participantId: string; readonly kind: string },
): string {
  const sideEntries =
    state.sides ??
    [...new Set(state.combatants.map((combatant) => combatant.sideNo))].map((sideNo) => ({
      sideNo,
      activeParticipantId: state.combatants.find((combatant) => combatant.sideNo === sideNo)
        ?.participantId,
    }));
  const sides = sideEntries.map((side) => {
    const active = state.combatants.find(
      (combatant) => combatant.participantId === side.activeParticipantId,
    );
    return active === undefined
      ? `Lado ${side.sideNo}: indisponível`
      : `Lado ${side.sideNo}: HP ${active.currentHp}/${active.maxHp} · ${statusLabel(active.majorStatus)}`;
  });
  const own = state.combatants.find(
    (combatant) => combatant.participantId === controller.participantId,
  );
  const moves = own?.moves
    ?.map((move) => `${move.slotNo}: PP ${move.ppCurrent ?? "—"}/${move.maxPp ?? "—"}`)
    .join(" · ");
  return [
    `⚔️ *BATALHA · Turno ${state.turnNumber}*`,
    ...sides,
    ...(moves === undefined || moves.length === 0 ? [] : [`Movimentos: ${moves}`]),
    "Envie a ação na última linha, por exemplo `/movimento 1`.",
  ].join("\n");
}

function turnSummary(
  state: BattleState,
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
): string {
  const damage = events
    .filter((entry) => entry.type === "DamageApplied")
    .reduce(
      (total, entry) =>
        total + (typeof entry.payload.damage === "number" ? entry.payload.damage : 0),
      0,
    );
  const effects = [
    ...(damage > 0 ? [`dano ${damage}`] : []),
    ...(events.some((entry) => entry.type === "StatusApplied") ? ["status aplicado"] : []),
    ...(events.some((entry) => entry.type === "Fainted") ? ["nocaute"] : []),
  ];
  return [
    `⚔️ Turno ${state.turnNumber} resolvido.`,
    ...(effects.length === 0 ? [] : [effects.join(" · ")]),
  ].join(" ");
}

export function createPveSceneRoutes(
  dependencies: PveSceneDependencies,
): readonly CommandRouteDefinition[] {
  const handle: Handler = async (context) => {
    const parsed = parseSceneAction(context.message.text);
    if (parsed.kind === "NONE")
      return err(appError("ACTION_INVALID", "Nenhuma diretiva de batalha encontrada."));
    if (parsed.kind === "INVALID")
      return err(appError("VALIDATION_FAILED", "Use uma única diretiva / na última linha."));
    const player = await dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) return player;
    const battleId = await dependencies.activeBattleId(player.value.playerId);
    if (battleId === null) {
      if (
        parsed.intent.type !== "FLEE" ||
        dependencies.encounters === undefined ||
        dependencies.encounterWriter === undefined
      ) {
        return err(appError("NOT_FOUND", "Nenhuma batalha PVE ativa."));
      }
      const encounter = await dependencies.encounters.activeForPlayer(player.value.playerId);
      if (!encounter.ok) {
        return err(appError("NOT_FOUND", "Nenhum encontro ativo para fugir."));
      }
      const fled = await dependencies.encounterWriter.flee({
        playerId: player.value.playerId,
        encounterId: encounter.value.encounterId,
        expectedRevision: encounter.value.revision,
      });
      if (!fled.ok) {
        return err(appError("ACTION_INVALID", "Não foi possível fugir deste encontro."));
      }
      return encounterReply(
        context,
        ["🏃 *VOCÊ FUGIU*", "", "_O encontro terminou._"].join("\n"),
        encounter.value.encounterId,
      );
    }

    const state = await dependencies.battle.currentState(battleId);
    if (!state.ok) return err(appError("ACTION_INVALID", state.error.message));
    const principal = await dependencies.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const controllers = await dependencies.controllers.listByBattle(battleId);
    const controller = activeController(
      state.value,
      controllers,
      (entry) =>
        (entry.kind === "PLAYER" && entry.playerId === player.value.playerId) ||
        (entry.kind === "NARRATOR" && entry.adminPrincipalId === principal?.principalId),
    );
    if (controller === undefined) {
      return err(appError("ACTION_INVALID", "Você não controla um ator nesta batalha."));
    }
    if (controller.kind === "NARRATOR" && principal === null)
      return err(appError("PLAYER_INELIGIBLE", "Narrador não autorizado."));
    if (parsed.intent.type === "CAPTURE") {
      if (
        state.value.battleType !== "WILD" ||
        controller.kind !== "PLAYER" ||
        dependencies.capture === undefined ||
        dependencies.encounters === undefined ||
        dependencies.captureBalls === undefined
      ) {
        return reply(context, "Captura não disponível nesta batalha.", battleId);
      }
      const target = activeWildParticipant(state.value);
      if (target === undefined || target.currentHp <= 0) {
        return reply(context, "Não há um Pokémon selvagem ativo para capturar.", battleId);
      }
      const encounter = await dependencies.encounters.activeForPlayer(player.value.playerId);
      if (!encounter.ok || encounter.value.battleId !== battleId) {
        return reply(context, "O encontro desta batalha não está disponível.", battleId);
      }
      const balls = await dependencies.captureBalls.listAvailable(
        player.value.playerId,
        encounter.value.contentReleaseId,
      );
      const ball = chooseBall(balls, parsed.intent.captureRef);
      if (ball === null) return reply(context, ballPrompt(balls), battleId);

      const correlation = parseCorrelationId(context.correlationId);
      if (!correlation.ok) {
        return err(appError("ACTION_INVALID", "A captura não pôde ser correlacionada."));
      }
      const captured = await dependencies.capture.attempt({
        playerId: player.value.playerId,
        encounterId: encounter.value.encounterId,
        expectedEncounterRevision: encounter.value.revision,
        expectedBattleVersion: state.value.version,
        targetWildNo: target.rosterPosition,
        ballItemId: ball.itemId,
        idempotencyKey: context.idempotencyKey,
        correlationId: correlation.value,
        causationId: context.causationId,
      });
      if (!captured.ok) {
        return reply(context, "A captura não está disponível agora. Use `/batalha`.", battleId);
      }
      if (captured.value.status === "FAILED") {
        return reply(
          context,
          [
            "💥 *A POKÉ BOLA ABRIU*",
            "",
            "_O Pokémon escapou._",
            "",
            "⚔️ A batalha continua. Use `/batalha`.",
          ].join("\n"),
          battleId,
        );
      }

      const placement = captured.value.placement;
      const placementText =
        placement === null
          ? "Pokémon registrado."
          : placement.placementKind === "TEAM"
            ? `Foi para a *equipe* · slot ${placement.slotNo}.`
            : `Foi para o *Box ${placement.boxNo ?? 1}* · slot ${placement.slotNo}.`;
      const after = await dependencies.battle.currentState(battleId);
      const continues = after.ok && after.value.status === "ACTIVE";
      return reply(
        context,
        [
          "✨ *CAPTURA CONCLUÍDA!*",
          "",
          placementText,
          "",
          continues
            ? "⚔️ _O encontro continua com o próximo Pokémon selvagem._"
            : "✅ _O encontro foi encerrado._",
          ...(continues ? ["Use `/batalha` para continuar."] : []),
        ].join("\n"),
        battleId,
      );
    }

    if (parsed.intent.type === "FLEE" && state.value.battleType === "PVP") {
      return reply(context, "Em PVP, use `/desistir` para encerrar sua participação.", battleId);
    }

    if (parsed.intent.type === "SURRENDER") {
      if (state.value.battleType !== "PVP" || controller.kind !== "PLAYER")
        return err(appError("ACTION_INVALID", "Desistência não permitida agora."));
      const surrendered = await dependencies.battle.surrenderPvp({
        battleId,
        playerId: player.value.playerId,
        expectedVersion: state.value.version,
      });
      if (!surrendered.ok) return err(appError("ACTION_INVALID", "A batalha já acabou."));
      return reply(context, "🏳️ Você desistiu. O adversário venceu.", battleId);
    }
    const action = actionFrom(state.value, controller.participantId, parsed);
    if (!action.ok) return action;
    if (controller.kind === "NARRATOR") {
      if (principal === null) return err(appError("PLAYER_INELIGIBLE", "Narrador não autorizado."));
      const resolved = await dependencies.battle.resolvePlayerTurn({
        battleId,
        playerId: null,
        adminPrincipalId: principal.principalId,
        expectedVersion: state.value.version,
        idempotencyKey: context.idempotencyKey,
        action: action.value,
      });
      if (!resolved.ok) return reply(context, "Ação não permitida agora. Use /batalha.", battleId);
      if (resolved.value.pending === true)
        return ok({ resultRefType: "BATTLE", resultRefId: battleId, outgoing: [] });
      return reply(context, turnSummary(resolved.value.state, resolved.value.events), battleId);
    }
    const resolved = await dependencies.battle.resolvePlayerTurn({
      battleId,
      playerId: player.value.playerId,
      expectedVersion: state.value.version,
      idempotencyKey: context.idempotencyKey,
      action: action.value,
    });
    if (!resolved.ok) return reply(context, "Ação não permitida agora. Use /batalha.", battleId);
    if (resolved.value.pending === true)
      return ok({ resultRefType: "BATTLE", resultRefId: battleId, outgoing: [] });
    return reply(context, turnSummary(resolved.value.state, resolved.value.events), battleId);
  };
  const controllerRoute =
    (kind: "NARRATOR" | "AUTO"): Handler =>
    async (context) => {
      const principal = await dependencies.admins.resolvePrincipal({
        provider: context.message.provider,
        externalId: context.message.senderRef,
      });
      if (principal === null)
        return err(
          appError("PLAYER_INELIGIBLE", "Apenas um narrador autorizado pode controlar a batalha."),
        );
      const player = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: context.message.senderRef,
      });
      if (!player.ok) return player;
      const battleId = await dependencies.activeBattleId(player.value.playerId);
      if (battleId === null) return err(appError("NOT_FOUND", "Nenhuma batalha PVE ativa."));
      const state = await dependencies.battle.currentState(battleId);
      if (!state.ok) return err(appError("ACTION_INVALID", state.error.message));
      const activeWild = activeWildParticipant(state.value);
      const eligible = (await dependencies.controllers.listByBattle(battleId)).filter((entry) =>
        kind === "NARRATOR"
          ? entry.kind === "AUTO"
          : entry.kind === "NARRATOR" && entry.adminPrincipalId === principal.principalId,
      );
      const candidate =
        activeWild === undefined
          ? eligible.length === 1
            ? eligible[0]
            : undefined
          : eligible.find((entry) => entry.participantId === activeWild.participantId);
      if (candidate === undefined) {
        return err(appError("ACTION_INVALID", "Controle de narrador indisponível."));
      }
      const changed = await dependencies.controllers.transition({
        participantId: candidate.participantId,
        expectedRevision: candidate.revision,
        kind,
        adminPrincipalId: kind === "NARRATOR" ? principal.principalId : null,
      });
      if (changed === null)
        return err(appError("REVISION_CONFLICT", "O controle mudou; tente novamente."));
      return reply(
        context,
        kind === "NARRATOR"
          ? [
              "🎙️ *CONTROLE DO NARRADOR*",
              "",
              "_Controle narrativo assumido._",
              "",
              "Use `/batalha` para ver o turno atual.",
              "Quando quiser devolver à IA, use `/automatico`.",
            ].join("\n")
          : ["🤖 *CONTROLE AUTOMÁTICO*", "", "_Controle automático restaurado._"].join("\n"),
        battleId,
      );
    };
  const battleHud: Handler = async (context) => {
    const player = await dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!player.ok) return player;
    const battleId = await dependencies.activeBattleId(player.value.playerId);
    if (battleId === null) return err(appError("NOT_FOUND", "Nenhuma batalha PVE ativa."));
    const state = await dependencies.battle.currentState(battleId);
    if (!state.ok) return err(appError("ACTION_INVALID", state.error.message));
    const controllers = await dependencies.controllers.listByBattle(battleId);
    const controller = activeController(
      state.value,
      controllers,
      (entry) => entry.kind === "PLAYER" && entry.playerId === player.value.playerId,
    );
    if (controller === undefined)
      return err(appError("ACTION_INVALID", "Você não controla um ator nesta batalha."));
    return reply(context, hud(state.value, controller), battleId);
  };
  return [
    ...["movimento", "trocar", "item", "capturar", "fugir", "desistir"].map((command) => ({
      command,
      handler: new FunctionalHandler(handle),
      policy: {
        requiredAnyGroupCapabilities: ["pve", "pvp"] as const,
        requiresMechanicalReady: true,
      },
    })),
    {
      command: "assumir",
      handler: new FunctionalHandler(controllerRoute("NARRATOR")),
      policy: {
        requiredGroupCapabilities: ["pve"] as const,
        requiredAdminCapability: "encounter.support" as const,
      },
    },
    {
      command: "automatico",
      handler: new FunctionalHandler(controllerRoute("AUTO")),
      policy: {
        requiredGroupCapabilities: ["pve"] as const,
        requiredAdminCapability: "encounter.support" as const,
      },
    },
    {
      command: "batalha",
      handler: new FunctionalHandler(battleHud),
      policy: {
        requiredAnyGroupCapabilities: ["pve", "pvp"] as const,
        requiresMechanicalReady: true,
      },
    },
  ];
}
export function createPveSceneConversationResolver(dependencies: PveSceneDependencies) {
  const routes = createPveSceneRoutes(dependencies);
  const handler = routes[0]?.handler;
  return {
    resolve: async (
      context: MessageHandlerContext,
    ): Promise<Result<MessageHandlerResult | null>> => {
      const parsed = parseSceneAction(context.message.text);
      if (parsed.kind === "NONE") return ok(null);
      if (handler === undefined) throw new Error("PVE scene action route is missing");
      return handler.handle(context);
    },
  };
}
