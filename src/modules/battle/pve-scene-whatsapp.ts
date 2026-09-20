import { type PlayerId, parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CaptureService } from "../capture/service.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { EncounterService } from "../encounter/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { OperationalUxReadModel } from "../messaging/operational-ux-read-model.js";
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
  readonly presentation: Pick<OperationalUxReadModel, "speciesDisplayName" | "moveDisplayNames">;
  readonly playerExternalRef?: (playerId: string) => Promise<string | null>;
  readonly admins: {
    resolvePrincipal(input: {
      readonly provider: string;
      readonly externalId: string;
    }): Promise<{ readonly principalId: string } | null>;
  };
}
function reactionDraft(context: MessageHandlerContext) {
  return {
    channel: "whatsapp",
    destinationRef: context.message.chatRef,
    messageType: "REACTION",
    payload: {
      emoji: "✅",
      targetExternalMessageId: context.message.externalMessageId,
      targetSenderRef: context.message.senderRef,
    },
    idempotencyKey: `${context.idempotencyKey}:reaction`,
  } as const;
}

function reply(
  context: MessageHandlerContext,
  text: string,
  battleId: string,
  options: {
    readonly mentions?: readonly string[];
    readonly react?: boolean;
  } = {},
): Result<MessageHandlerResult> {
  const mentions = options.mentions ?? [];
  return ok({
    resultRefType: "BATTLE",
    resultRefId: battleId,
    outgoing: [
      ...(options.react === true ? [reactionDraft(context)] : []),
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text,
          ...(mentions.length === 0 ? {} : { mentions }),
        },
        idempotencyKey: `${context.idempotencyKey}:battle`,
      },
    ],
  });
}

function ackOnly(context: MessageHandlerContext, battleId: string): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "BATTLE",
    resultRefId: battleId,
    outgoing: [reactionDraft(context)],
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

function normalizeLookup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ");
}

async function moveSlotFor(
  state: BattleState,
  actor: BattleState["combatants"][number],
  moveRef: string,
  presentation: Pick<OperationalUxReadModel, "moveDisplayNames">,
): Promise<number | null> {
  const normalized = normalizeLookup(moveRef);
  if (/^\d+$/u.test(normalized)) {
    const slot = Number(normalized);
    return Number.isSafeInteger(slot) && slot > 0 ? slot : null;
  }

  const names = await presentation.moveDisplayNames(
    state.contentReleaseId,
    actor.moves.map((move) => move.moveId),
  );
  const matches = actor.moves.filter((move) => {
    const name = normalizeLookup(names.get(move.moveId) ?? "");
    if (name.length === 0) return false;
    if (normalized === name) return true;
    if (!normalized.startsWith(name)) return false;
    const boundary = normalized[name.length];
    return (
      boundary === " " ||
      boundary === "," ||
      boundary === "." ||
      boundary === ";" ||
      boundary === ":" ||
      boundary === "!" ||
      boundary === "?" ||
      boundary === "_" ||
      boundary === "*" ||
      boundary === "~" ||
      boundary === "`"
    );
  });
  return matches.length === 1 ? (matches[0]?.slotNo ?? null) : null;
}

async function actionFrom(
  state: BattleState,
  actorParticipantId: string,
  intent: ReturnType<typeof parseSceneAction>,
  presentation: Pick<OperationalUxReadModel, "moveDisplayNames">,
): Promise<Result<BattleAction>> {
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
    case "USE_MOVE": {
      if (target === undefined) return err(appError("ACTION_INVALID", "Sem alvo disponível."));
      const moveSlot = await moveSlotFor(state, actor, intent.intent.moveRef, presentation);
      if (moveSlot === null) {
        return err(appError("ACTION_INVALID", "Movimento não encontrado para este Pokémon."));
      }
      return ok({
        type: "USE_MOVE",
        actorParticipantId,
        targetParticipantId: target.participantId,
        moveSlot,
      });
    }
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

function controlledRoster(
  state: BattleState,
  controller: BattleParticipantController,
  controllers: readonly BattleParticipantController[],
): readonly BattleState["combatants"][number][] {
  const actor = state.combatants.find(
    (combatant) => combatant.participantId === controller.participantId,
  );
  if (actor === undefined) return [];

  if (controller.kind === "PLAYER" && controller.playerId !== null) {
    const controlled = new Set(
      controllers
        .filter((entry) => entry.kind === "PLAYER" && entry.playerId === controller.playerId)
        .map((entry) => entry.participantId),
    );
    return state.combatants
      .filter(
        (combatant) => combatant.sideNo === actor.sideNo && controlled.has(combatant.participantId),
      )
      .sort((left, right) => left.rosterPosition - right.rosterPosition);
  }

  const side = state.sides.find((entry) => entry.sideNo === actor.sideNo);
  if (side === undefined) return [];
  const slot = (side.slots ?? [side]).find((entry) =>
    entry.participantIds.includes(actor.participantId),
  );
  const participantIds = new Set(slot?.participantIds ?? []);
  return state.combatants
    .filter((combatant) => participantIds.has(combatant.participantId))
    .sort((left, right) => left.rosterPosition - right.rosterPosition);
}

function switchAction(
  state: BattleState,
  controller: BattleParticipantController,
  controllers: readonly BattleParticipantController[],
  switchSlot: number,
): Result<BattleAction> {
  const roster = controlledRoster(state, controller, controllers);
  const target = roster[switchSlot - 1];
  if (target === undefined) {
    return err(
      appError(
        "ACTION_INVALID",
        "Slot de troca inválido. Use `/batalha` para ver as opções disponíveis.",
      ),
    );
  }
  if (target.participantId === controller.participantId) {
    return err(appError("ACTION_INVALID", "Esse Pokémon já está em campo."));
  }
  if (target.currentHp <= 0) {
    return err(appError("ACTION_INVALID", "Esse Pokémon não pode mais lutar."));
  }
  return ok({
    type: "SWITCH",
    actorParticipantId: controller.participantId,
    switchToParticipantId: target.participantId,
  });
}

function chooseBall(
  options: readonly PveCaptureBallOption[],
  reference: string,
): PveCaptureBallOption | null {
  if (options.length === 0) return null;
  const normalized = normalizeLookup(reference);
  if (normalized.length === 0) return options.length === 1 ? (options[0] ?? null) : null;
  const matches = options.filter((option) => normalizeLookup(option.displayName) === normalized);
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
  return status === null || status === undefined ? "—" : status.key.toLocaleLowerCase("pt-BR");
}

function hud(
  state: BattleState,
  controller: BattleParticipantController,
  controllers: readonly BattleParticipantController[],
): string {
  const own = state.combatants.find(
    (combatant) => combatant.participantId === controller.participantId,
  );
  const opponentSide = state.sides.find((side) => {
    const ownSide = own?.sideNo;
    return ownSide !== undefined && side.sideNo !== ownSide && side.result === null;
  });
  const opponent =
    opponentSide === undefined
      ? undefined
      : state.combatants.find(
          (combatant) => combatant.participantId === opponentSide.activeParticipantId,
        );

  const lines = [
    `⚔️ *BATALHA · Turno ${state.turnNumber}*`,
    "",
    own === undefined
      ? "Seu Pokémon · indisponível"
      : `Seu Pokémon · HP ${own.currentHp}/${own.maxHp} · status ${statusLabel(own.majorStatus)}`,
    opponent === undefined
      ? "Oponente · —"
      : `Oponente · HP ${opponent.currentHp}/${opponent.maxHp} · status ${statusLabel(opponent.majorStatus)}`,
  ];

  if (own !== undefined && own.currentHp <= 0) {
    const roster = controlledRoster(state, controller, controllers);
    const reserves = roster
      .map((combatant, index) => ({ combatant, slot: index + 1 }))
      .filter(
        ({ combatant }) => combatant.participantId !== own.participantId && combatant.currentHp > 0,
      );
    if (reserves.length > 0) {
      lines.push(
        "",
        "💥 *TROCA OBRIGATÓRIA*",
        ...reserves.map(
          ({ combatant, slot }) =>
            `${slot}. HP ${combatant.currentHp}/${combatant.maxHp} · \`/trocar ${slot}\``,
        ),
      );
    }
  }

  return lines.join("\n");
}

function mentionTag(ref: string): string {
  const local = ref.split("@", 1)[0] ?? ref;
  return `@${local.replace(/:\d+$/u, "")}`;
}

function statusText(value: unknown): string {
  switch (value) {
    case "BURN":
      return "queimado";
    case "POISON":
      return "envenenado";
    case "PARALYSIS":
      return "paralisado";
    case "SLEEP":
      return "adormecido";
    case "FREEZE":
      return "congelado";
    default:
      return "afetado por um status";
  }
}

async function turnSummary(
  dependencies: Pick<PveSceneDependencies, "presentation" | "playerExternalRef">,
  state: BattleState,
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
): Promise<{ readonly text: string; readonly mentions: readonly string[] }> {
  const speciesByParticipant = new Map<string, string>();
  await Promise.all(
    state.combatants.map(async (combatant) => {
      const displayName = await dependencies.presentation.speciesDisplayName(
        state.contentReleaseId,
        combatant.speciesId,
      );
      speciesByParticipant.set(combatant.participantId, displayName ?? "Pokémon");
    }),
  );

  const moveIds = [
    ...new Set(
      events.flatMap((entry) =>
        entry.type === "MoveUsed" && typeof entry.payload.moveId === "string"
          ? [entry.payload.moveId]
          : [],
      ),
    ),
  ];
  const moveNames = await dependencies.presentation.moveDisplayNames(
    state.contentReleaseId,
    moveIds,
  );

  const nameOf = (participantId: unknown) =>
    typeof participantId === "string"
      ? (speciesByParticipant.get(participantId) ?? "Pokémon")
      : "Pokémon";

  const lines: string[] = [`⚔️ *Turno ${state.turnNumber}*`, ""];
  let actionStarted = false;

  for (const entry of events) {
    switch (entry.type) {
      case "MoveUsed": {
        if (actionStarted && lines[lines.length - 1] !== "") lines.push("");
        const moveId = typeof entry.payload.moveId === "string" ? entry.payload.moveId : "";
        const moveName = moveNames.get(moveId) ?? "Movimento";
        lines.push(`${nameOf(entry.payload.participantId)} usou *${moveName}*.`);
        actionStarted = true;
        break;
      }
      case "MoveMissed":
        lines.push("O ataque errou.");
        break;
      case "DamageApplied": {
        const damage = typeof entry.payload.damage === "number" ? entry.payload.damage : null;
        const remainingHp =
          typeof entry.payload.remainingHp === "number" ? entry.payload.remainingHp : null;
        const effectiveness =
          typeof entry.payload.effectivenessBasisPoints === "number"
            ? entry.payload.effectivenessBasisPoints
            : null;
        if (entry.payload.critical === true) lines.push("Golpe crítico.");
        if (effectiveness === 0) lines.push("Não teve efeito.");
        else if (effectiveness !== null && effectiveness > 10_000) lines.push("É super efetivo.");
        else if (effectiveness !== null && effectiveness < 10_000)
          lines.push("Não é muito efetivo.");

        if (damage !== null && remainingHp !== null) {
          lines.push(
            `${nameOf(entry.payload.participantId)}: ${remainingHp + damage} → ${remainingHp} HP.`,
          );
        }
        break;
      }
      case "StatusApplied":
        lines.push(
          `${nameOf(entry.payload.participantId)} ficou ${statusText(entry.payload.status)}.`,
        );
        break;
      case "Fainted":
        lines.push(`💥 ${nameOf(entry.payload.participantId)} não consegue mais lutar.`);
        break;
      case "Switched":
        lines.push(`${nameOf(entry.payload.toParticipantId)} entrou em campo.`);
        break;
      case "ActionSkipped":
        if (entry.payload.reason === "CAPTURE_FAILED") {
          if (actionStarted && lines[lines.length - 1] !== "") lines.push("");
          lines.push("🔴 A Poké Ball foi lançada.", "O Pokémon escapou.");
          actionStarted = true;
        }
        break;
      case "BattleEnded":
        if (entry.payload.status === "FLED") lines.push("💨 A batalha terminou em fuga.");
        break;
      default:
        break;
    }
  }

  if (lines.length === 2) lines.push("Turno resolvido.");

  const mentions: string[] = [];
  if (dependencies.playerExternalRef !== undefined) {
    for (const side of state.sides) {
      if (side.playerId === null) continue;
      const ref = await dependencies.playerExternalRef(side.playerId);
      if (ref !== null && !mentions.includes(ref)) mentions.push(ref);
    }
  }
  const firstMention = mentions[0];
  const secondMention = mentions[1];
  if (firstMention !== undefined && secondMention !== undefined) {
    lines.push("", mentionTag(firstMention), "x", mentionTag(secondMention));
  }

  return { text: lines.join("\n"), mentions };
}

export function createPveSceneRoutes(
  dependencies: PveSceneDependencies,
): readonly CommandRouteDefinition[] {
  const handle: Handler = async (context) => {
    const parsed = parseSceneAction(context.message.text);
    if (parsed.kind === "NONE")
      return err(appError("ACTION_INVALID", "Nenhuma diretiva de batalha encontrada."));
    if (parsed.kind === "INVALID")
      return err(appError("VALIDATION_FAILED", "Use apenas um comando mecânico por mensagem."));
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

    const rejectedAction = (code: string) =>
      reply(
        context,
        code === "TURN_WINDOW_ALREADY_SUBMITTED"
          ? "A ação deste turno já foi definida."
          : "Ação não permitida agora. Use `/batalha`.",
        battleId,
      );

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
      const captureAction: BattleAction = {
        type: "CAPTURE_ATTEMPT",
        actorParticipantId: controller.participantId,
        ballItemId: ball.itemId,
        targetParticipantId: target.participantId,
      };
      const captured = await dependencies.capture.attempt({
        playerId: player.value.playerId,
        encounterId: encounter.value.encounterId,
        expectedEncounterRevision: encounter.value.revision,
        expectedBattleVersion: state.value.version,
        actorParticipantId: controller.participantId,
        targetWildNo: target.rosterPosition,
        ballItemId: ball.itemId,
        idempotencyKey: context.idempotencyKey,
        correlationId: correlation.value,
        causationId: context.causationId,
      });
      if (!captured.ok) {
        if (captured.error.details?.turnWindowCode === "TURN_WINDOW_ALREADY_SUBMITTED") {
          return rejectedAction("TURN_WINDOW_ALREADY_SUBMITTED");
        }
        return reply(context, "A captura não está disponível agora. Use `/batalha`.", battleId);
      }
      if (captured.value.status === "FAILED") {
        const resolved = await dependencies.battle.resolvePlayerTurn({
          battleId,
          playerId: player.value.playerId,
          expectedVersion: state.value.version,
          idempotencyKey: context.idempotencyKey,
          action: captureAction,
        });
        if (!resolved.ok) {
          if (captured.value.replayed) {
            return reply(
              context,
              ["🔴 A Poké Ball foi lançada.", "", "O Pokémon escapou."].join("\n"),
              battleId,
              { react: true },
            );
          }
          return rejectedAction(resolved.error.code);
        }
        if (resolved.value.pending === true) return ackOnly(context, battleId);
        const summary = await turnSummary(
          dependencies,
          resolved.value.state,
          resolved.value.events,
        );
        return reply(context, summary.text, battleId, {
          mentions: summary.mentions,
          react: true,
        });
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
          "🔴 *Pokémon capturado.*",
          placementText,
          ...(continues ? ["O encontro continua."] : []),
        ].join("\n"),
        battleId,
        { react: true },
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
      return reply(context, "🏳️ Você desistiu. O adversário venceu.", battleId, { react: true });
    }
    const action =
      parsed.intent.type === "SWITCH"
        ? switchAction(state.value, controller, controllers, parsed.intent.switchSlot)
        : await actionFrom(
            state.value,
            controller.participantId,
            parsed,
            dependencies.presentation,
          );
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
      if (!resolved.ok) return rejectedAction(resolved.error.code);
      if (resolved.value.pending === true) return ackOnly(context, battleId);
      const summary = await turnSummary(dependencies, resolved.value.state, resolved.value.events);
      return reply(context, summary.text, battleId, {
        mentions: summary.mentions,
        react: true,
      });
    }

    const resolved = await dependencies.battle.resolvePlayerTurn({
      battleId,
      playerId: player.value.playerId,
      expectedVersion: state.value.version,
      idempotencyKey: context.idempotencyKey,
      action: action.value,
    });
    if (!resolved.ok) return rejectedAction(resolved.error.code);
    if (resolved.value.pending === true) return ackOnly(context, battleId);
    const summary = await turnSummary(dependencies, resolved.value.state, resolved.value.events);
    return reply(context, summary.text, battleId, {
      mentions: summary.mentions,
      react: true,
    });
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
    return reply(context, hud(state.value, controller, controllers), battleId);
  };
  return [
    ...["movimento", "trocar", "item", "capturar", "fugir", "desistir"].map((command) => ({
      command,
      allowEmbedded: true,
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
