import { type PlayerId, parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CaptureService } from "../capture/service.js";
import type { EncounterView } from "../encounter/contracts.js";
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
import type { CanonicalPveBattleStartInput, PveBattleStartService } from "./pve-battle-start.js";
import type { BattleRuntimeService } from "./runtime.js";
import type { TurnWindowAggregate } from "./turn-window.js";
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

export interface PveReplyContext {
  readonly resultRefType: string | null;
  readonly resultRefId: string | null;
  readonly mentions: readonly string[];
}

export interface PveReplyContextResolver {
  resolve(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly externalMessageId: string;
  }): Promise<PveReplyContext | null>;
}

export interface PveSceneDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly activeBattleId: (playerId: PlayerId) => Promise<string | null>;
  /** Legacy single-battle resolver retained for isolated tests/backwards compatibility. */
  readonly narratorBattleId?: (adminPrincipalId: string) => Promise<string | null>;
  readonly narratorBattleIds?: (adminPrincipalId: string) => Promise<readonly string[]>;
  readonly replyContext?: PveReplyContextResolver;
  readonly battleStart?: Pick<PveBattleStartService, "startCanonical">;
  readonly roster?: Pick<OperationalUxReadModel, "listTeam" | "teamPokemonDetail">;
  readonly turnWindowForBattleVersion?: (
    battleId: string,
    version: number,
  ) => Promise<TurnWindowAggregate | null>;
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

function isBattleStartEncounterStatus(
  status: EncounterView["status"],
): status is CanonicalPveBattleStartInput["status"] {
  return (
    status === "CREATED" || status === "PRESENTED" || status === "ENGAGED" || status === "IN_BATTLE"
  );
}

async function replyContextFor(
  dependencies: PveSceneDependencies,
  context: MessageHandlerContext,
): Promise<PveReplyContext | null> {
  const externalMessageId = context.message.replyToExternalMessageId;
  if (externalMessageId === null || dependencies.replyContext === undefined) return null;
  return dependencies.replyContext.resolve({
    provider: context.message.provider,
    chatRef: context.message.chatRef,
    externalMessageId,
  });
}

async function narratorBattleIdsFor(
  dependencies: PveSceneDependencies,
  principalId: string,
): Promise<readonly string[]> {
  if (dependencies.narratorBattleIds !== undefined) {
    return [...new Set(await dependencies.narratorBattleIds(principalId))];
  }
  if (dependencies.narratorBattleId === undefined) return [];
  const one = await dependencies.narratorBattleId(principalId);
  return one === null ? [] : [one];
}

function privateResult(
  context: MessageHandlerContext,
  text: string,
  refType: "BATTLE" | "ENCOUNTER" | null,
  refId: string | null,
  react = true,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: refType,
    resultRefId: refId,
    outgoing: [
      ...(react ? [reactionDraft(context)] : []),
      {
        channel: "whatsapp",
        destinationRef: context.message.senderRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:private`,
      },
    ],
  });
}

function numberedMoveLines(
  moves: readonly {
    readonly slotNo: number;
    readonly displayName: string;
    readonly ppCurrent: number | null;
    readonly maxPp: number | null;
  }[],
): readonly string[] {
  return moves.map((move) =>
    move.maxPp === null
      ? `\`${String(move.slotNo).padStart(2, "0")}\` ${move.displayName} · PP \`${move.ppCurrent ?? "—"}\``
      : `\`${String(move.slotNo).padStart(2, "0")}\` ${move.displayName} · PP \`${move.ppCurrent ?? "—"} / ${move.maxPp}\``,
  );
}

function moveReferenceMatches(
  moveRef: string,
  move: { readonly slotNo: number; readonly displayName: string },
): boolean {
  const normalized = normalizeLookup(moveRef);
  if (/^\d+$/u.test(normalized)) return Number(normalized) === move.slotNo;
  return normalizeLookup(move.displayName) === normalized;
}

async function preflightPlayerMove(
  dependencies: PveSceneDependencies,
  playerId: PlayerId,
  moveRef: string,
): Promise<Result<void>> {
  if (dependencies.roster === undefined) {
    return err(
      appError("FEATURE_UNAVAILABLE", "Pre-battle move lookup is unavailable.", {
        userMessage:
          "Não foi possível conferir esse movimento agora. Use `/moves` e tente novamente.",
      }),
    );
  }
  const team = await dependencies.roster.listTeam(playerId);
  const active = team.find((entry) => entry.currentHp > 0);
  if (active === undefined) {
    return err(
      appError("PLAYER_INELIGIBLE", "No battle-ready Pokemon was found.", {
        userMessage: "Você não possui um Pokémon apto para iniciar a batalha.",
      }),
    );
  }
  const detail = await dependencies.roster.teamPokemonDetail(playerId, active.slotNo);
  if (detail === null) {
    return err(appError("NOT_FOUND", "Active team Pokemon detail was not found."));
  }
  const move = detail.moves.find((entry) => moveReferenceMatches(moveRef, entry));
  if (move === undefined) {
    return err(
      appError("VALIDATION_FAILED", "Opening move is not known by the active Pokemon.", {
        userMessage: "Seu Pokémon não possui esse movimento. Use `/moves` para consultar.",
      }),
    );
  }
  if (move.ppCurrent !== null && move.ppCurrent <= 0) {
    return err(
      appError("FLOW_BLOCKED", "Opening move has no PP.", {
        userMessage: "Esse movimento está sem PP. Use `/moves` para consultar os disponíveis.",
      }),
    );
  }
  return ok(undefined);
}

async function preflightWildMove(
  dependencies: PveSceneDependencies,
  encounter: EncounterView,
  moveRef: string,
): Promise<Result<void>> {
  const wilds =
    encounter.wilds === undefined || encounter.wilds.length === 0
      ? [{ wildNo: 1, status: "ACTIVE" as const, snapshot: encounter.snapshot }]
      : encounter.wilds;
  const wild = wilds.find((entry) => entry.status === "ACTIVE") ?? wilds[0];
  if (wild === undefined) return err(appError("NOT_FOUND", "No active wild Pokemon was found."));
  const names = await dependencies.presentation.moveDisplayNames(
    encounter.contentReleaseId,
    wild.snapshot.moves.map((move) => move.moveId),
  );
  const moves = wild.snapshot.moves.map((move, index) => ({
    slotNo: index + 1,
    displayName: names.get(move.moveId) ?? "Movimento",
    ppCurrent: move.ppCurrent ?? null,
  }));
  const selected = moves.find((entry) => moveReferenceMatches(moveRef, entry));
  if (selected === undefined) {
    return err(
      appError("VALIDATION_FAILED", "Opening wild move is unavailable.", {
        userMessage: "Esse selvagem não possui esse movimento. Use `/moves` para consultar.",
      }),
    );
  }
  if (selected.ppCurrent !== null && selected.ppCurrent <= 0) {
    return err(
      appError("FLOW_BLOCKED", "Opening wild move has no PP.", {
        userMessage: "Esse movimento está sem PP. Use `/moves` para consultar.",
      }),
    );
  }
  return ok(undefined);
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
  if (actor === undefined)
    return err(
      appError("FLOW_BLOCKED", "Ator de batalha indisponível.", {
        userMessage: "Ator de batalha indisponível agora.",
      }),
    );
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
      if (target === undefined)
        return err(
          appError("FLOW_BLOCKED", "Sem alvo disponível.", {
            userMessage: "Não há um alvo disponível para essa ação.",
          }),
        );
      const moveSlot = await moveSlotFor(state, actor, intent.intent.moveRef, presentation);
      if (moveSlot === null) {
        return err(
          appError("VALIDATION_FAILED", "Movimento não encontrado para este Pokémon.", {
            userMessage: "Esse Pokémon não possui o movimento informado.",
          }),
        );
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
      return err(
        appError("FLOW_BLOCKED", "Desistir não é uma ação PVE disponível.", {
          userMessage: "Desistir não está disponível nesta batalha PVE.",
        }),
      );
    default:
      return err(
        appError("FLOW_BLOCKED", "Essa diretiva ainda não é uma ação PVE disponível.", {
          userMessage: "Essa ação não está disponível nesta batalha PVE.",
        }),
      );
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
  const active = new Set(
    state.sides.flatMap((side) => (side.slots ?? [side]).map((slot) => slot.activeParticipantId)),
  );
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
        "VALIDATION_FAILED",
        "Slot de troca inválido. Use `/batalha` para ver as opções disponíveis.",
        {
          userMessage: "Slot de troca inválido. Use `/batalha` para ver as opções disponíveis.",
        },
      ),
    );
  }
  if (target.participantId === controller.participantId) {
    return err(
      appError("FLOW_BLOCKED", "Esse Pokémon já está em campo.", {
        userMessage: "Esse Pokémon já está em campo.",
      }),
    );
  }
  if (target.currentHp <= 0) {
    return err(
      appError("FLOW_BLOCKED", "Esse Pokémon não pode mais lutar.", {
        userMessage: "Esse Pokémon não pode mais lutar.",
      }),
    );
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
    return ["〔!〕 *𝗦𝗘𝗠 𝗣𝗢𝗞É 𝗕𝗢𝗟𝗔𝗦*", "", "> _Você não possui uma Poké Bola disponível._"].join(
      "\n",
    );
  }
  return [
    "◇ *𝗣𝗢𝗞É 𝗕𝗢𝗟𝗔*",
    "",
    ...options.map(
      (option, index) =>
        `\`${String(index + 1).padStart(2, "0")}\` ${option.displayName} · ×${option.quantity.toString()}`,
    ),
    "",
    `› _Use \`/capturar ${options[0]?.displayName ?? "Poké Ball"}\`._`,
  ].join("\n");
}

function statusLabel(status: BattleState["combatants"][number]["majorStatus"]): string {
  if (status === null || status === undefined) return "—";
  return status.key === "BAD_POISON"
    ? "gravemente envenenado"
    : status.key.toLocaleLowerCase("pt-BR");
}

async function hud(
  state: BattleState,
  controller: BattleParticipantController,
  controllers: readonly BattleParticipantController[],
  presentation: Pick<OperationalUxReadModel, "speciesDisplayName" | "moveDisplayNames">,
  playerRef: string,
  ownActionState: "SUBMITTED" | "PENDING" | null = null,
): Promise<string> {
  const own = state.combatants.find(
    (combatant) => combatant.participantId === controller.participantId,
  );
  const ownSide = own?.sideNo;
  const opponentSide = state.sides.find(
    (side) => ownSide !== undefined && side.sideNo !== ownSide && side.result === null,
  );
  const opponent =
    opponentSide === undefined
      ? undefined
      : state.combatants.find(
          (combatant) => combatant.participantId === opponentSide.activeParticipantId,
        );

  const [ownName, opponentName] = await Promise.all([
    own === undefined
      ? Promise.resolve<string | null>(null)
      : presentation.speciesDisplayName(state.contentReleaseId, own.speciesId),
    opponent === undefined
      ? Promise.resolve<string | null>(null)
      : presentation.speciesDisplayName(state.contentReleaseId, opponent.speciesId),
  ]);

  const lines = [
    "◇ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔*",
    `　Turno \`${String(state.turnNumber).padStart(2, "0")}\` · ${mentionTag(playerRef)}`,
    "",
    own === undefined
      ? "_Seu Pokémon está indisponível._"
      : `*${ownName ?? "Pokémon"}*${own.shiny ? " ✦" : ""} · Nv. \`${own.level}\`\nHP \`${own.currentHp} / ${own.maxHp}\`${own.majorStatus === null ? "" : ` · ${statusLabel(own.majorStatus)}`}`,
    opponent === undefined
      ? ""
      : `*${opponentName ?? "Pokémon"}*${opponent.shiny ? " ✦" : ""} · Nv. \`${opponent.level}\`\nHP \`${opponent.currentHp} / ${opponent.maxHp}\`${opponent.majorStatus === null ? "" : ` · ${statusLabel(opponent.majorStatus)}`}`,
  ];

  if (own !== undefined && own.currentHp <= 0) {
    const roster = controlledRoster(state, controller, controllers);
    const reserves = roster
      .map((combatant, index) => ({ combatant, slot: index + 1 }))
      .filter(
        ({ combatant }) => combatant.participantId !== own.participantId && combatant.currentHp > 0,
      );
    if (reserves.length > 0) {
      const reserveNames = await Promise.all(
        reserves.map(({ combatant }) =>
          presentation.speciesDisplayName(state.contentReleaseId, combatant.speciesId),
        ),
      );
      lines.push(
        "",
        "〔!〕 *𝗧𝗥𝗢𝗖𝗔 𝗢𝗕𝗥𝗜𝗚𝗔𝗧Ó𝗥𝗜𝗔*",
        "",
        ...reserves.map(
          ({ combatant, slot }, index) =>
            `\`${String(slot).padStart(2, "0")}\` ${reserveNames[index] ?? "Pokémon"} · HP \`${combatant.currentHp} / ${combatant.maxHp}\``,
        ),
        "",
        "› _Use `/trocar <número>`._",
      );
      return lines.join("\n");
    }
  }

  if (controller.kind === "NARRATOR") {
    lines.push("", "> _O selvagem está sob seu controle._");
  } else if (ownActionState === "SUBMITTED") {
    lines.push("", "〔✓〕 Sua ação já foi definida.");
  } else if (ownActionState === "PENDING") {
    lines.push("", "› _Sua ação ainda não foi definida._");
  }
  lines.push("", "› _Use `/moves` para consultar os movimentos._");
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

async function battleMovesText(
  dependencies: PveSceneDependencies,
  state: BattleState,
  actor: BattleState["combatants"][number],
  contextLabel: string,
): Promise<string> {
  const [speciesName, names] = await Promise.all([
    dependencies.presentation.speciesDisplayName(state.contentReleaseId, actor.speciesId),
    dependencies.presentation.moveDisplayNames(
      state.contentReleaseId,
      actor.moves.map((move) => move.moveId),
    ),
  ]);
  const moves = actor.moves.map((move) => ({
    slotNo: move.slotNo,
    displayName: names.get(move.moveId) ?? "Movimento",
    ppCurrent: move.ppCurrent ?? null,
    maxPp: move.maxPp ?? null,
  }));
  return [
    "◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*",
    `　${speciesName ?? "Pokémon"} · ${contextLabel}`,
    "",
    ...numberedMoveLines(moves),
    "",
    "› _Na cena, use `/movimento 1` ou o nome do golpe._",
  ].join("\n");
}

async function playerCurrentMovesText(
  dependencies: PveSceneDependencies,
  playerId: PlayerId,
): Promise<Result<string>> {
  if (dependencies.roster === undefined) {
    return err(appError("FEATURE_UNAVAILABLE", "Current Pokémon move lookup is unavailable."));
  }
  const team = await dependencies.roster.listTeam(playerId);
  const active = team.find((entry) => entry.currentHp > 0);
  if (active === undefined) {
    return err(
      appError("PLAYER_INELIGIBLE", "No battle-ready Pokémon was found.", {
        userMessage: "Você não possui um Pokémon apto para agir agora.",
      }),
    );
  }
  const detail = await dependencies.roster.teamPokemonDetail(playerId, active.slotNo);
  if (detail === null) return err(appError("NOT_FOUND", "Active Pokémon detail was not found."));
  return ok(
    [
      "◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*",
      `　${detail.nickname?.trim() || detail.displayName} · Pokémon atual`,
      "",
      ...numberedMoveLines(detail.moves),
      "",
      "› _Na cena, use `/movimento 1` ou o nome do golpe._",
    ].join("\n"),
  );
}

async function wildEncounterMovesText(
  dependencies: PveSceneDependencies,
  encounter: EncounterView,
  targetRef: string | null,
): Promise<string> {
  const wilds =
    encounter.wilds === undefined || encounter.wilds.length === 0
      ? [{ wildNo: 1, status: "ACTIVE" as const, snapshot: encounter.snapshot }]
      : encounter.wilds;
  const wild = wilds.find((entry) => entry.status === "ACTIVE") ?? wilds[0];
  if (wild === undefined) return "◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*\n\n_Nenhum selvagem ativo._";
  const [speciesName, names] = await Promise.all([
    dependencies.presentation.speciesDisplayName(
      encounter.contentReleaseId,
      wild.snapshot.speciesId,
    ),
    dependencies.presentation.moveDisplayNames(
      encounter.contentReleaseId,
      wild.snapshot.moves.map((move) => move.moveId),
    ),
  ]);
  const moves = wild.snapshot.moves.map((move, index) => ({
    slotNo: index + 1,
    displayName: names.get(move.moveId) ?? "Movimento",
    ppCurrent: move.ppCurrent ?? null,
    maxPp: null,
  }));
  return [
    "◇ *𝗠𝗢𝗩𝗜𝗠𝗘𝗡𝗧𝗢𝗦*",
    `　${speciesName ?? "Pokémon selvagem"}${targetRef === null ? "" : ` · ${mentionTag(targetRef)}`}`,
    "",
    ...numberedMoveLines(moves),
    "",
    "› _Na cena, use `/movimento 1` ou o nome do golpe._",
  ].join("\n");
}

async function narratorBattleChoiceText(
  dependencies: PveSceneDependencies,
  battleIds: readonly string[],
): Promise<{ readonly text: string; readonly mentions: readonly string[] }> {
  const lines = ["▣ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔𝗦 𝗘𝗠 𝗔𝗡𝗗𝗔𝗠𝗘𝗡𝗧𝗢*", "　Condução do narrador", ""];
  const mentions: string[] = [];
  let index = 0;
  for (const battleId of battleIds) {
    const state = await dependencies.battle.currentState(battleId);
    if (!state.ok) continue;
    const wild = activeWildParticipant(state.value);
    const wildName =
      wild === undefined
        ? "Selvagem"
        : ((await dependencies.presentation.speciesDisplayName(
            state.value.contentReleaseId,
            wild.speciesId,
          )) ?? "Selvagem");
    const playerSide = state.value.sides.find((side) => side.playerId !== null);
    const ref =
      playerSide?.playerId === null ||
      playerSide?.playerId === undefined ||
      dependencies.playerExternalRef === undefined
        ? null
        : await dependencies.playerExternalRef(playerSide.playerId);
    index += 1;
    if (ref !== null) mentions.push(ref);
    lines.push(
      `\`${String(index).padStart(2, "0")}\` ${ref === null ? "Treinador" : mentionTag(ref)} · ${wildName}`,
    );
  }
  lines.push("", "› _Responda à batalha desejada ou mencione o treinador._");
  return { text: lines.join("\n"), mentions };
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
    case "BAD_POISON":
      return "gravemente envenenado";
    case "PARALYSIS":
      return "paralisado";
    case "SLEEP":
      return "adormecido";
    case "FREEZE":
      return "congelado";
    case "CONFUSION":
      return "confuso";
    case "FLINCH":
      return "abalado";
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
      speciesByParticipant.set(
        combatant.participantId,
        `${displayName ?? "Pokémon"}${combatant.shiny ? " ✨" : ""}`,
      );
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

  const lines: string[] = [`◇ *𝗧𝗨𝗥𝗡𝗢 ${String(state.turnNumber).padStart(2, "0")}*`, ""];
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
            `${nameOf(entry.payload.participantId)} · HP \`${remainingHp + damage} → ${remainingHp}\``,
          );
        }
        break;
      }
      case "HpRestored": {
        const amount = typeof entry.payload.amount === "number" ? entry.payload.amount : null;
        const remainingHp =
          typeof entry.payload.remainingHp === "number" ? entry.payload.remainingHp : null;
        if (amount !== null && remainingHp !== null) {
          lines.push(
            `${nameOf(entry.payload.participantId)} · HP \`${remainingHp - amount} → ${remainingHp}\``,
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
        lines.push(`〔!〕 ${nameOf(entry.payload.participantId)} não consegue mais lutar.`);
        break;
      case "Switched":
        lines.push(`${nameOf(entry.payload.toParticipantId)} entrou em campo.`);
        break;
      case "ActionSkipped":
        if (entry.payload.reason === "CAPTURE_FAILED") {
          if (actionStarted && lines[lines.length - 1] !== "") lines.push("");
          lines.push("A Poké Ball foi lançada.", "O Pokémon escapou.");
          actionStarted = true;
        }
        break;
      case "BattleEnded":
        if (entry.payload.status === "FLED") lines.push("> _A batalha terminou em fuga._");
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
    lines[1] = `　${mentionTag(firstMention)} × ${mentionTag(secondMention)}`;
  } else if (firstMention !== undefined) {
    lines[1] = `　${mentionTag(firstMention)}`;
  } else {
    lines.splice(1, 1);
  }

  return { text: lines.join("\n"), mentions };
}

export function createPveSceneRoutes(
  dependencies: PveSceneDependencies,
): readonly CommandRouteDefinition[] {
  const handle: Handler = async (context) => {
    const parsed = parseSceneAction(context.message.text?.replace(/\s+@\S+\s*$/u, "") ?? null);
    if (parsed.kind === "NONE")
      return err(
        appError("VALIDATION_FAILED", "Nenhuma diretiva de batalha encontrada.", {
          userMessage: "Não encontrei um comando mecânico de batalha nessa mensagem.",
        }),
      );
    if (parsed.kind === "INVALID")
      return err(appError("VALIDATION_FAILED", "Use apenas um comando mecânico por mensagem."));

    const principal = await dependencies.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const player = await dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const playerId = player.ok ? player.value.playerId : null;
    const mentions = context.message.mentions ?? [];
    if (mentions.length > 1) {
      return err(
        appError("VALIDATION_FAILED", "Use no máximo uma menção por ação.", {
          userMessage: "Responda à mensagem da batalha desejada ou mencione apenas um treinador.",
        }),
      );
    }

    const replyContext = await replyContextFor(dependencies, context);
    let explicitTargetPlayerId: PlayerId | null = null;
    if (principal !== null && mentions[0] !== undefined) {
      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: mentions[0],
      });
      if (!target.ok) return target;
      explicitTargetPlayerId = target.value.playerId;
    }

    let battleId: string | null =
      replyContext?.resultRefType === "BATTLE" ? replyContext.resultRefId : null;

    if (battleId === null && explicitTargetPlayerId !== null) {
      battleId = await dependencies.activeBattleId(explicitTargetPlayerId);
    }

    if (
      battleId === null &&
      principal !== null &&
      explicitTargetPlayerId === null &&
      replyContext?.resultRefType !== "ENCOUNTER"
    ) {
      const controlled = await narratorBattleIdsFor(dependencies, principal.principalId);
      if (controlled.length === 1) {
        battleId = controlled[0] ?? null;
      } else if (controlled.length > 1 && replyContext?.resultRefType !== "ENCOUNTER") {
        return err(
          appError("VALIDATION_FAILED", "Narrator controls more than one active battle.", {
            userMessage:
              "Você conduz mais de uma batalha. Responda à mensagem da batalha desejada ou mencione o treinador.",
          }),
        );
      }
    }

    if (battleId === null && playerId !== null && principal === null) {
      battleId = await dependencies.activeBattleId(playerId);
    }

    if (battleId === null) {
      if (dependencies.encounters === undefined) {
        return err(appError("NOT_FOUND", "Nenhuma batalha ou encontro ativo."));
      }

      let encounterPlayerId: PlayerId | null = explicitTargetPlayerId;
      if (
        encounterPlayerId === null &&
        principal !== null &&
        replyContext?.resultRefType === "ENCOUNTER" &&
        replyContext.mentions.length === 1
      ) {
        const repliedTarget = await dependencies.players.resolvePlayer({
          provider: context.message.provider,
          externalId: replyContext.mentions[0] ?? "",
        });
        if (repliedTarget.ok) encounterPlayerId = repliedTarget.value.playerId;
      }
      if (encounterPlayerId === null && principal === null) encounterPlayerId = playerId;

      if (
        parsed.intent.type === "FLEE" &&
        principal === null &&
        encounterPlayerId !== null &&
        dependencies.encounterWriter !== undefined
      ) {
        const encounter = await dependencies.encounters.activeForPlayer(encounterPlayerId);
        if (!encounter.ok) return err(appError("NOT_FOUND", "Nenhum encontro ativo para fugir."));
        const fled = await dependencies.encounterWriter.flee({
          playerId: encounterPlayerId,
          encounterId: encounter.value.encounterId,
          expectedRevision: encounter.value.revision,
        });
        if (!fled.ok) {
          return err(
            appError("FLOW_BLOCKED", "Não foi possível fugir deste encontro.", {
              userMessage: "Não foi possível fugir deste encontro agora.",
            }),
          );
        }
        return encounterReply(
          context,
          ["〔‹〕 *ENCONTRO ENCERRADO*", "", "> _Você fugiu._"].join("\n"),
          encounter.value.encounterId,
        );
      }

      if (encounterPlayerId === null) {
        return err(
          appError("NOT_FOUND", "No encounter target could be resolved.", {
            userMessage:
              principal === null
                ? "Você não possui um encontro ativo."
                : "Responda à mensagem do encontro desejado ou mencione o treinador.",
          }),
        );
      }

      const encounter = await dependencies.encounters.activeForPlayer(encounterPlayerId);
      if (!encounter.ok) {
        return err(
          appError("NOT_FOUND", "Nenhum encontro ativo.", {
            userMessage: "Não há um encontro ativo para essa ação.",
          }),
        );
      }

      if (encounter.value.battleId !== null) {
        battleId = encounter.value.battleId;
      } else {
        if (parsed.intent.type === "SWITCH") {
          return err(
            appError("FLOW_BLOCKED", "A battle has not started yet.", {
              userMessage: "A batalha ainda não começou. Faça uma ação primeiro.",
            }),
          );
        }
        if (parsed.intent.type === "SURRENDER") {
          return err(
            appError("FLOW_BLOCKED", "There is no PVP battle to surrender.", {
              userMessage: "Não há uma batalha PVP ativa.",
            }),
          );
        }
        if (principal !== null && parsed.intent.type !== "USE_MOVE") {
          return err(
            appError("FLOW_BLOCKED", "Narrator opening action must be a move.", {
              userMessage:
                "Para abrir esse combate como narrador, narre e use `/movimento <golpe>`.",
            }),
          );
        }

        if (parsed.intent.type === "USE_MOVE") {
          const preflight =
            principal === null
              ? await preflightPlayerMove(dependencies, encounterPlayerId, parsed.intent.moveRef)
              : await preflightWildMove(dependencies, encounter.value, parsed.intent.moveRef);
          if (!preflight.ok) return preflight;
        } else if (parsed.intent.type === "CAPTURE") {
          if (dependencies.captureBalls === undefined || principal !== null) {
            return err(
              appError("FEATURE_UNAVAILABLE", "Opening capture is unavailable.", {
                userMessage: "A captura não está disponível agora.",
              }),
            );
          }
          const balls = await dependencies.captureBalls.listAvailable(
            encounterPlayerId,
            encounter.value.contentReleaseId,
          );
          if (chooseBall(balls, parsed.intent.captureRef) === null) {
            return privateResult(
              context,
              ballPrompt(balls),
              "ENCOUNTER",
              encounter.value.encounterId,
              false,
            );
          }
        }

        if (dependencies.battleStart === undefined) {
          return err(
            appError("FEATURE_UNAVAILABLE", "Automatic battle start is unavailable.", {
              userMessage: "Não foi possível iniciar a batalha por essa ação agora.",
            }),
          );
        }
        if (!isBattleStartEncounterStatus(encounter.value.status)) {
          return err(
            appError("FLOW_BLOCKED", "Encounter is not in a battle-startable state.", {
              userMessage: "Esse encontro já não pode iniciar uma nova batalha.",
            }),
          );
        }

        const started = await dependencies.battleStart.startCanonical({
          playerId: encounterPlayerId,
          encounterId: encounter.value.encounterId,
          status: encounter.value.status,
          expectedRevision: encounter.value.revision,
          firstTurnInitiative: principal === null ? "PLAYER" : "WILD",
        });
        if (!started.ok) {
          return err(
            appError("FLOW_BLOCKED", started.error.message, {
              userMessage:
                "O encontro mudou antes da ação ser registrada. Use `/batalha` e tente novamente.",
            }),
          );
        }
        battleId = started.value.start.battleId;

        if (principal !== null) {
          const openingState = started.value.initialization.state;
          const activeWild = activeWildParticipant(openingState);
          if (activeWild === undefined) {
            return err(appError("FLOW_BLOCKED", "Opening wild actor was not found."));
          }
          const initialControllers = await dependencies.controllers.listByBattle(battleId);
          const automatic = initialControllers.find(
            (entry) => entry.participantId === activeWild.participantId && entry.kind === "AUTO",
          );
          if (automatic === undefined) {
            return err(
              appError("FLOW_BLOCKED", "Opening wild controller was not available.", {
                userMessage: "O selvagem não pôde ser assumido para essa primeira ação.",
              }),
            );
          }
          const changed = await dependencies.controllers.transition({
            participantId: automatic.participantId,
            expectedRevision: automatic.revision,
            kind: "NARRATOR",
            adminPrincipalId: principal.principalId,
          });
          if (changed === null) {
            return err(
              appError("REVISION_CONFLICT", "Opening wild control changed.", {
                userMessage: "O controle do selvagem mudou. Tente novamente.",
              }),
            );
          }
        }
      }
    }

    if (battleId === null) {
      return err(appError("NOT_FOUND", "Nenhuma batalha PVE ativa."));
    }

    const state = await dependencies.battle.currentState(battleId);
    if (!state.ok)
      return err(
        appError("FLOW_BLOCKED", state.error.message, {
          userMessage: "A batalha não aceita essa ação no estado atual.",
        }),
      );
    const controllers = await dependencies.controllers.listByBattle(battleId);
    const controller = activeController(
      state.value,
      controllers,
      (entry) =>
        (playerId !== null && entry.kind === "PLAYER" && entry.playerId === playerId) ||
        (principal !== null &&
          entry.kind === "NARRATOR" &&
          entry.adminPrincipalId === principal.principalId),
    );
    if (controller === undefined) {
      return err(
        appError("PLAYER_INELIGIBLE", "Você não controla um ator nesta batalha.", {
          userMessage: "Você não controla um ator nesta batalha.",
        }),
      );
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
        playerId === null ||
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
      const encounter = await dependencies.encounters.activeForPlayer(playerId);
      if (!encounter.ok || encounter.value.battleId !== battleId) {
        return reply(context, "O encontro desta batalha não está disponível.", battleId);
      }
      const balls = await dependencies.captureBalls.listAvailable(
        playerId,
        encounter.value.contentReleaseId,
      );
      const ball = chooseBall(balls, parsed.intent.captureRef);
      if (ball === null) return reply(context, ballPrompt(balls), battleId);

      const correlation = parseCorrelationId(context.correlationId);
      if (!correlation.ok) {
        return err(
          appError("ACTION_INVALID", "A captura não pôde ser correlacionada.", {
            userMessage:
              "Não foi possível registrar a captura. Tente novamente; se persistir, envie o código de suporte.",
          }),
        );
      }
      const captureAction: BattleAction = {
        type: "CAPTURE_ATTEMPT",
        actorParticipantId: controller.participantId,
        ballItemId: ball.itemId,
        targetParticipantId: target.participantId,
      };
      const captured = await dependencies.capture.attempt({
        playerId,
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
          playerId,
          expectedVersion: state.value.version,
          idempotencyKey: context.idempotencyKey,
          action: captureAction,
        });
        if (!resolved.ok) {
          if (captured.value.replayed) {
            return reply(
              context,
              ["◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔*", "", "A Poké Ball foi lançada.", "O Pokémon escapou."].join("\n"),
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
      const capturedName =
        (await dependencies.presentation.speciesDisplayName(
          state.value.contentReleaseId,
          target.speciesId,
        )) ?? "Pokémon";
      return reply(
        context,
        [
          "〔✓〕 *𝗖𝗔𝗣𝗧𝗨𝗥𝗔 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔*",
          "",
          `*${capturedName}* foi capturado.`,
          placementText,
          ...(continues ? ["", "> _O encontro continua._"] : []),
        ].join("\n"),
        battleId,
        { react: true },
      );
    }

    if (parsed.intent.type === "FLEE" && state.value.battleType === "PVP") {
      return reply(context, "Em PVP, use `/desistir` para encerrar sua participação.", battleId);
    }

    if (parsed.intent.type === "SURRENDER") {
      if (state.value.battleType !== "PVP" || controller.kind !== "PLAYER" || playerId === null)
        return err(
          appError("FLOW_BLOCKED", "Desistência não permitida agora.", {
            userMessage: "Você não pode desistir desta batalha agora.",
          }),
        );
      const surrendered = await dependencies.battle.surrenderPvp({
        battleId,
        playerId,
        expectedVersion: state.value.version,
      });
      if (!surrendered.ok)
        return err(
          appError("FLOW_BLOCKED", "A batalha já acabou.", {
            userMessage: "Essa batalha já terminou.",
          }),
        );
      return reply(
        context,
        ["〔×〕 *𝗕𝗔𝗧𝗔𝗟𝗛𝗔 𝗘𝗡𝗖𝗘𝗥𝗥𝗔𝗗𝗔*", "", "> _Você desistiu. O adversário venceu._"].join("\n"),
        battleId,
        { react: true },
      );
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

    if (playerId === null) {
      return err(
        appError("PLAYER_INELIGIBLE", "Player identity disappeared during battle action."),
      );
    }
    const resolved = await dependencies.battle.resolvePlayerTurn({
      battleId,
      playerId,
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
      if (principal === null) {
        return err(
          appError("PLAYER_INELIGIBLE", "Apenas um narrador autorizado pode controlar a batalha."),
        );
      }

      const mentions = context.message.mentions ?? [];
      if (mentions.length > 1) {
        return err(
          appError("VALIDATION_FAILED", "Use no máximo uma menção.", {
            userMessage: "Responda à batalha desejada ou mencione apenas um treinador.",
          }),
        );
      }

      const replyContext = await replyContextFor(dependencies, context);
      const targetRef = mentions[0] ?? null;
      let battleId = replyContext?.resultRefType === "BATTLE" ? replyContext.resultRefId : null;

      if (battleId === null && targetRef !== null) {
        const target = await dependencies.players.resolvePlayer({
          provider: context.message.provider,
          externalId: targetRef,
        });
        if (!target.ok) return target;
        battleId = await dependencies.activeBattleId(target.value.playerId);
      }

      if (battleId === null && kind === "AUTO") {
        const controlled = await narratorBattleIdsFor(dependencies, principal.principalId);
        if (controlled.length === 1) battleId = controlled[0] ?? null;
        else if (controlled.length > 1) {
          const choice = await narratorBattleChoiceText(dependencies, controlled);
          return privateResult(context, choice.text, null, null);
        }
      }

      if (battleId === null) {
        return err(
          appError("NOT_FOUND", "Nenhuma batalha PVE foi identificada.", {
            userMessage:
              kind === "NARRATOR"
                ? "Responda à mensagem da batalha desejada ou use `/assumir @treinador`."
                : "Responda à batalha desejada ou use `/automatico @treinador`.",
          }),
        );
      }

      const state = await dependencies.battle.currentState(battleId);
      if (!state.ok) {
        return err(
          appError("FLOW_BLOCKED", state.error.message, {
            userMessage: "A batalha não aceita essa ação no estado atual.",
          }),
        );
      }
      if (state.value.battleType !== "WILD") {
        return err(
          appError("FLOW_BLOCKED", "Narrator control is only available in wild battles.", {
            userMessage: "O controle do narrador só está disponível em batalhas contra selvagens.",
          }),
        );
      }

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
        return err(
          appError("FEATURE_UNAVAILABLE", "Controle de narrador indisponível.", {
            userMessage:
              kind === "NARRATOR"
                ? "O selvagem não está disponível para ser assumido agora."
                : "Esse selvagem não está sob seu controle.",
          }),
        );
      }

      const changed = await dependencies.controllers.transition({
        participantId: candidate.participantId,
        expectedRevision: candidate.revision,
        kind,
        adminPrincipalId: kind === "NARRATOR" ? principal.principalId : null,
      });
      if (changed === null) {
        return err(
          appError("REVISION_CONFLICT", "O controle mudou; tente novamente.", {
            userMessage: "O turno mudou enquanto o controle era alterado. Tente novamente.",
          }),
        );
      }

      const actor = state.value.combatants.find(
        (combatant) => combatant.participantId === changed.participantId,
      );
      const speciesName =
        actor === undefined
          ? null
          : await dependencies.presentation.speciesDisplayName(
              state.value.contentReleaseId,
              actor.speciesId,
            );
      const displayTarget = targetRef ?? replyContext?.mentions[0] ?? null;
      const suffix = displayTarget === null ? "" : ` · ${mentionTag(displayTarget)}`;

      return reply(
        context,
        kind === "NARRATOR"
          ? [
              "◇ *𝗖𝗢𝗡𝗧𝗥𝗢𝗟𝗘 𝗗𝗢 𝗡𝗔𝗥𝗥𝗔𝗗𝗢𝗥*",
              `　${speciesName ?? "Pokémon selvagem"}${suffix}`,
              "",
              ...(actor === undefined ? [] : [`HP \`${actor.currentHp} / ${actor.maxHp}\``]),
              "",
              "> _O selvagem agora está sob seu controle._",
              "",
              `› _Use \`/moves${displayTarget === null ? "" : ` ${mentionTag(displayTarget)}`}\` para consultar os movimentos._`,
              `› _Use \`/automatico${displayTarget === null ? "" : ` ${mentionTag(displayTarget)}`}\` para devolver à IA._`,
            ]
              .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
              .join("\n")
          : [
              "◇ *𝗖𝗢𝗡𝗧𝗥𝗢𝗟𝗘 𝗔𝗨𝗧𝗢𝗠Á𝗧𝗜𝗖𝗢*",
              `　${speciesName ?? "Pokémon selvagem"}${suffix}`,
              "",
              "> _O selvagem voltou ao controle da IA._",
            ].join("\n"),
        battleId,
        { mentions: displayTarget === null ? [] : [displayTarget] },
      );
    };

  const resolveBattleForQuery = async (
    context: MessageHandlerContext,
    principal: { readonly principalId: string } | null,
  ): Promise<
    | {
        readonly kind: "BATTLE";
        readonly battleId: string;
        readonly playerId: PlayerId | null;
        readonly targetRef: string | null;
      }
    | { readonly kind: "CHOICE"; readonly text: string; readonly mentions: readonly string[] }
    | {
        readonly kind: "NONE";
        readonly playerId: PlayerId | null;
        readonly targetRef: string | null;
        readonly replyContext: PveReplyContext | null;
      }
  > => {
    const mentions = context.message.mentions ?? [];
    if (mentions.length > 1) {
      return { kind: "NONE", playerId: null, targetRef: null, replyContext: null };
    }
    const replyContext = await replyContextFor(dependencies, context);
    const targetRef = mentions[0] ?? null;
    let targetPlayerId: PlayerId | null = null;

    if (targetRef !== null && principal !== null) {
      const target = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: targetRef,
      });
      if (target.ok) targetPlayerId = target.value.playerId;
    }

    if (replyContext?.resultRefType === "BATTLE" && replyContext.resultRefId !== null) {
      return {
        kind: "BATTLE",
        battleId: replyContext.resultRefId,
        playerId: targetPlayerId,
        targetRef: targetRef ?? replyContext.mentions[0] ?? null,
      };
    }

    if (targetPlayerId !== null) {
      const battleId = await dependencies.activeBattleId(targetPlayerId);
      if (battleId !== null) {
        return { kind: "BATTLE", battleId, playerId: targetPlayerId, targetRef };
      }
    }

    if (
      principal !== null &&
      targetPlayerId === null &&
      replyContext?.resultRefType !== "ENCOUNTER"
    ) {
      const controlled = await narratorBattleIdsFor(dependencies, principal.principalId);
      if (controlled.length === 1) {
        return {
          kind: "BATTLE",
          battleId: controlled[0] ?? "",
          playerId: null,
          targetRef: null,
        };
      }
      if (controlled.length > 1) {
        const choice = await narratorBattleChoiceText(dependencies, controlled);
        return { kind: "CHOICE", ...choice };
      }
    }

    const self = await dependencies.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const selfPlayerId = self.ok ? self.value.playerId : null;
    if (selfPlayerId !== null) {
      const battleId = await dependencies.activeBattleId(selfPlayerId);
      if (battleId !== null) {
        return {
          kind: "BATTLE",
          battleId,
          playerId: selfPlayerId,
          targetRef: context.message.senderRef,
        };
      }
    }

    return {
      kind: "NONE",
      playerId: targetPlayerId ?? selfPlayerId,
      targetRef,
      replyContext,
    };
  };

  const battleHud: Handler = async (context) => {
    const principal = await dependencies.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const resolved = await resolveBattleForQuery(context, principal);
    if (resolved.kind === "CHOICE") {
      return privateResult(context, resolved.text, null, null);
    }
    if (resolved.kind !== "BATTLE" || resolved.battleId.length === 0) {
      return err(
        appError("NOT_FOUND", "Nenhuma batalha ativa.", {
          userMessage: "Nenhuma batalha ativa foi encontrada.",
        }),
      );
    }

    const state = await dependencies.battle.currentState(resolved.battleId);
    if (!state.ok) return err(appError("FLOW_BLOCKED", state.error.message));
    const controllers = await dependencies.controllers.listByBattle(resolved.battleId);
    let controller: BattleParticipantController | undefined;

    if (principal !== null && state.value.battleType === "WILD") {
      const wild = activeWildParticipant(state.value);
      controller =
        wild === undefined
          ? undefined
          : controllers.find((entry) => entry.participantId === wild.participantId);
    }
    if (controller === undefined && resolved.playerId !== null) {
      controller = activeController(
        state.value,
        controllers,
        (entry) => entry.kind === "PLAYER" && entry.playerId === resolved.playerId,
      );
    }
    if (controller === undefined) {
      const self = await dependencies.players.resolvePlayer({
        provider: context.message.provider,
        externalId: context.message.senderRef,
      });
      if (self.ok) {
        controller = activeController(
          state.value,
          controllers,
          (entry) => entry.kind === "PLAYER" && entry.playerId === self.value.playerId,
        );
      }
    }
    if (controller === undefined) {
      return err(
        appError("PLAYER_INELIGIBLE", "Você não controla nem conduz esta batalha.", {
          userMessage: "Essa batalha não está disponível para sua consulta.",
        }),
      );
    }

    let ownActionState: "SUBMITTED" | "PENDING" | null = null;
    if (dependencies.turnWindowForBattleVersion !== undefined && controller.kind === "PLAYER") {
      const window = await dependencies.turnWindowForBattleVersion(
        resolved.battleId,
        state.value.version,
      );
      if (window !== null) {
        const required =
          window.window.requiredControllers?.some(
            (entry) => entry.participantId === controller.participantId,
          ) ??
          window.window.requiredPlayers.some((entry) => entry.playerId === controller.playerId);
        if (required) {
          const submitted = window.submissions.some(
            (entry) =>
              (entry.status === "ACTIVE" || entry.status === "COMMITTED") &&
              (entry.action.actorParticipantId === controller.participantId ||
                (controller.playerId !== null && entry.playerId === controller.playerId)),
          );
          ownActionState = submitted ? "SUBMITTED" : "PENDING";
        }
      }
    }

    return reply(
      context,
      await hud(
        state.value,
        controller,
        controllers,
        dependencies.presentation,
        resolved.targetRef ?? context.message.senderRef,
        ownActionState,
      ),
      resolved.battleId,
      { mentions: resolved.targetRef === null ? [] : [resolved.targetRef] },
    );
  };

  const moves: Handler = async (context) => {
    const principal = await dependencies.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const resolved = await resolveBattleForQuery(context, principal);
    if (resolved.kind === "CHOICE") {
      return privateResult(context, resolved.text, null, null);
    }

    if (resolved.kind === "BATTLE" && resolved.battleId.length > 0) {
      const state = await dependencies.battle.currentState(resolved.battleId);
      if (!state.ok) return err(appError("FLOW_BLOCKED", state.error.message));
      const controllers = await dependencies.controllers.listByBattle(resolved.battleId);
      let actor: BattleState["combatants"][number] | undefined;

      if (principal !== null && state.value.battleType === "WILD") {
        actor = activeWildParticipant(state.value);
      } else {
        const self = await dependencies.players.resolvePlayer({
          provider: context.message.provider,
          externalId: context.message.senderRef,
        });
        if (self.ok) {
          const ownController = activeController(
            state.value,
            controllers,
            (entry) => entry.kind === "PLAYER" && entry.playerId === self.value.playerId,
          );
          actor =
            ownController === undefined
              ? undefined
              : state.value.combatants.find(
                  (entry) => entry.participantId === ownController.participantId,
                );
        }
      }

      if (actor === undefined) {
        return err(
          appError("PLAYER_INELIGIBLE", "Move list is not available for this battle.", {
            userMessage: "Os movimentos dessa batalha não estão disponíveis para você.",
          }),
        );
      }
      return privateResult(
        context,
        await battleMovesText(
          dependencies,
          state.value,
          actor,
          principal !== null
            ? resolved.targetRef === null
              ? "Batalha atual"
              : mentionTag(resolved.targetRef)
            : state.value.battleType === "PVP"
              ? "PVP"
              : "Batalha atual",
        ),
        "BATTLE",
        resolved.battleId,
      );
    }

    if (resolved.kind !== "NONE") {
      return err(appError("NOT_FOUND", "Nenhuma batalha ou encontro ativo."));
    }

    let encounterPlayerId = resolved.playerId;
    let targetRef = resolved.targetRef;
    if (
      principal !== null &&
      encounterPlayerId === null &&
      resolved.replyContext?.resultRefType === "ENCOUNTER" &&
      resolved.replyContext.mentions.length === 1
    ) {
      targetRef = resolved.replyContext.mentions[0] ?? null;
      if (targetRef !== null) {
        const target = await dependencies.players.resolvePlayer({
          provider: context.message.provider,
          externalId: targetRef,
        });
        if (target.ok) encounterPlayerId = target.value.playerId;
      }
    }

    if (encounterPlayerId === null) {
      return err(
        appError("NOT_FOUND", "No current Pokémon context was found.", {
          userMessage:
            principal === null
              ? "Você não possui uma batalha ou encontro ativo."
              : "Responda ao encontro desejado ou use `/moves @treinador`.",
        }),
      );
    }

    if (principal !== null && dependencies.encounters !== undefined) {
      const encounter = await dependencies.encounters.activeForPlayer(encounterPlayerId);
      if (encounter.ok && encounter.value.battleId === null) {
        return privateResult(
          context,
          await wildEncounterMovesText(dependencies, encounter.value, targetRef),
          "ENCOUNTER",
          encounter.value.encounterId,
        );
      }
    }

    const ownMoves = await playerCurrentMovesText(dependencies, encounterPlayerId);
    if (!ownMoves.ok) return ownMoves;
    return privateResult(context, ownMoves.value, null, null);
  };

  return [
    ...["movimento", "trocar", "capturar", "fugir", "desistir"].map((command) => ({
      command,
      allowEmbedded: true,
      handler: new FunctionalHandler(handle),
      policy: {
        requiredAnyGroupCapabilities: ["pve", "pvp"] as const,
        requiresMechanicalReady: true,
        mechanicalReadyAdminBypassCapability: "encounter.support",
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
      command: "moves",
      handler: new FunctionalHandler(moves),
      policy: {
        requiredAnyGroupCapabilities: ["pve", "pvp"] as const,
        requiresMechanicalReady: true,
        mechanicalReadyAdminBypassCapability: "encounter.support",
      },
    },
    {
      command: "batalha",
      handler: new FunctionalHandler(battleHud),
      policy: {
        requiredAnyGroupCapabilities: ["pve", "pvp"] as const,
        requiresMechanicalReady: true,
        mechanicalReadyAdminBypassCapability: "encounter.support",
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
