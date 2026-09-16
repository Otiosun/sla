import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { BattleAction, BattleState } from "./contracts.js";
import type { BattleParticipantControllerRepository } from "./participant-controller.js";
import type { BattleRuntimeService } from "./runtime.js";
import { parseSceneAction } from "./scene-action.js";

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;
class FunctionalHandler implements MessageRouteHandler {
  constructor(private readonly fn: Handler) {}
  handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}
export interface PveSceneDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly activeBattleId: (playerId: PlayerId) => Promise<string | null>;
  readonly battle: Pick<
    BattleRuntimeService,
    "currentState" | "resolvePlayerTurn" | "surrenderPvp"
  >;
  readonly controllers: Pick<BattleParticipantControllerRepository, "listByBattle" | "transition">;
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
function actionFrom(
  state: BattleState,
  actorParticipantId: string,
  intent: ReturnType<typeof parseSceneAction>,
): Result<BattleAction> {
  if (intent.kind !== "ACTION")
    return err(appError("VALIDATION_FAILED", "Diretiva de batalha inválida."));
  const actor = state.combatants.find((entry) => entry.participantId === actorParticipantId);
  const target = state.combatants.find(
    (entry) => entry.sideNo !== actor?.sideNo && entry.currentHp > 0,
  );
  if (actor === undefined) return err(appError("ACTION_INVALID", "Ator de batalha indisponível."));
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
    if (battleId === null) return err(appError("NOT_FOUND", "Nenhuma batalha PVE ativa."));
    const state = await dependencies.battle.currentState(battleId);
    if (!state.ok) return err(appError("ACTION_INVALID", state.error.message));
    const principal = await dependencies.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const controller = (await dependencies.controllers.listByBattle(battleId)).find(
      (entry) =>
        (entry.kind === "PLAYER" && entry.playerId === player.value.playerId) ||
        (entry.kind === "NARRATOR" && entry.adminPrincipalId === principal?.principalId),
    );
    if (controller === undefined)
      return err(appError("ACTION_INVALID", "Você não controla um ator nesta batalha."));
    if (controller.kind === "NARRATOR" && principal === null)
      return err(appError("PLAYER_INELIGIBLE", "Narrador não autorizado."));
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
      const candidates = (await dependencies.controllers.listByBattle(battleId)).filter((entry) =>
        kind === "NARRATOR"
          ? entry.kind === "AUTO"
          : entry.kind === "NARRATOR" && entry.adminPrincipalId === principal.principalId,
      );
      const candidate = candidates[0];
      if (candidates.length !== 1 || candidate === undefined)
        return err(appError("ACTION_INVALID", "Controle de narrador indisponível ou ambíguo."));
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
          ? "🎙️ Controle narrativo assumido."
          : "🤖 Controle automático restaurado.",
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
    const controller = controllers.find((entry) => entry.playerId === player.value.playerId);
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
