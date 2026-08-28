import type { BattleAction, BattleCombatant } from "../battle/contracts.js";
import type { BattleOperationalReadService } from "../battle/operational-read-service.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { WorldService } from "../world/service.js";
import { parseCorrelationId, type PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "./contracts.js";
import type { OperationalUxReadModel } from "./operational-ux-read-model.js";
import type { MessageRouteHandler } from "./ports.js";
import type { CommandRouteDefinition } from "./router.js";

const PAGE_SIZE = 15;

export interface OperationalUxDependencies {
  readonly registration: Pick<
    PlayerRegistrationService,
    "resolvePlayer" | "resolveOrCreatePlayer" | "createProfile" | "selectRegion"
  >;
  readonly starter: Pick<
    PlayerStarterService,
    | "listStarterOptions"
    | "prepareStarterSelection"
    | "grantStarter"
    | "completeOnboarding"
    | "getProfile"
  >;
  readonly world: Pick<WorldService, "ensureInitialLocation" | "getLocation" | "travel">;
  readonly encounter: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly battle: Pick<BattleOperationalReadService, "forPlayer">;
  readonly reads: OperationalUxReadModel;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly handler: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.handler(context);
  }
}

function commandArgs(context: MessageHandlerContext): readonly string[] {
  const text = context.message.text?.trim() ?? "";
  return text.split(/\s+/).slice(1);
}

function identity(context: MessageHandlerContext): { provider: string; externalId: string } {
  return { provider: context.message.provider, externalId: context.message.senderRef };
}

function textResult(
  context: MessageHandlerContext,
  text: string,
  ref: { type: string; id: string } | null = null,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: ref?.type ?? null,
    resultRefId: ref?.id ?? null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:reply`,
      },
    ],
  });
}

function pageNumber(args: readonly string[]): Result<number> {
  if (args.length === 0) return ok(1);
  const page = Number(args[0]);
  return Number.isSafeInteger(page) && page > 0
    ? ok(page)
    : err(appError("VALIDATION_FAILED", "Página inválida. Use um número inteiro maior que zero."));
}

function pageSlice<T>(values: readonly T[], page: number): readonly T[] {
  return values.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function pageFooter(total: number, page: number, command: string): string {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return totalPages <= 1 ? "" : `\n\nPágina ${page}/${totalPages} · ${command} <página>`;
}

async function resolvePlayer(
  dependencies: OperationalUxDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.registration.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

function onboardingMenu(state: string): string {
  switch (state) {
    case "NEW":
      return "🎒 *Bem-vindo ao RPG Pokémon*\n\n1. Crie seu treinador:\n`$registrar Seu Nome`";
    case "PROFILE_CREATED":
      return "🗺️ *Treinador criado*\n\nAgora escolha sua região:\n`$regioes`";
    case "REGION_SELECTED":
    case "STARTER_PENDING":
      return "🔥 *Região definida*\n\nVeja os iniciais disponíveis:\n`$starters`\nDepois escolha com `$starter <número>`.";
    case "STARTER_GRANTED":
      return "✅ *Seu inicial já foi entregue.*\n\nFinalize a entrada no mundo com:\n`$concluir`";
    case "COMPLETE":
      return [
        "📟 *CENTRAL DO TREINADOR*",
        "",
        "`$perfil` · treinador",
        "`$equipe` · equipe atual",
        "`$inventario` · itens",
        "`$pokedex` · registros",
        "`$onde` · local e rotas",
        "`$encontro` · encontro ativo",
        "`$batalha` · estado mecânico da batalha",
        "",
        "Cenas comuns continuam livres entre jogadores e narrador.",
      ].join("\n");
    default:
      return "Estado de onboarding não reconhecido.";
  }
}

function activeCombatant(
  state: {
    readonly sides: readonly { sideNo: number; activeParticipantId: string }[];
    readonly combatants: readonly BattleCombatant[];
  },
  sideNo: number,
): BattleCombatant | null {
  const side = state.sides.find((candidate) => candidate.sideNo === sideNo);
  if (side === undefined) return null;
  return (
    state.combatants.find((candidate) => candidate.participantId === side.activeParticipantId) ??
    null
  );
}

function statusLabel(status: BattleCombatant["majorStatus"]): string {
  return status === null ? "—" : status.key;
}

function actionLabel(
  action: BattleAction,
  state: { readonly combatants: readonly BattleCombatant[] },
  moveNames: ReadonlyMap<string, string>,
): string {
  const actor = state.combatants.find(
    (candidate) => candidate.participantId === action.actorParticipantId,
  );
  if (action.type === "USE_MOVE") {
    const move = actor?.moves.find((candidate) => candidate.slotNo === action.moveSlot);
    return move === undefined
      ? `usar movimento do slot ${action.moveSlot}`
      : `usar ${moveNames.get(move.moveId) ?? `movimento ${action.moveSlot}`}`;
  }
  if (action.type === "SWITCH") {
    const target = state.combatants.find(
      (candidate) => candidate.participantId === action.switchToParticipantId,
    );
    return `trocar para ${target === undefined ? "reserva" : `reserva #${target.rosterPosition}`}`;
  }
  if (action.type === "USE_ITEM") return "usar item";
  return "tentar fugir";
}

export function createOperationalUxRoutes(
  dependencies: OperationalUxDependencies,
): readonly CommandRouteDefinition[] {
  const menu: Handler = async (context) => {
    const resolved = await dependencies.registration.resolveOrCreatePlayer(identity(context));
    if (!resolved.ok) return resolved;
    return textResult(context, onboardingMenu(resolved.value.state), {
      type: "PLAYER",
      id: resolved.value.playerId,
    });
  };

  const register: Handler = async (context) => {
    const resolved = await dependencies.registration.resolveOrCreatePlayer(identity(context));
    if (!resolved.ok) return resolved;
    const trainerName = commandArgs(context).join(" ").trim();
    if (trainerName.length === 0) {
      return err(appError("VALIDATION_FAILED", "Informe o nome: $registrar Seu Nome"));
    }
    const created = await dependencies.registration.createProfile(resolved.value.playerId, {
      trainerName,
      locale: "pt-BR",
    });
    if (!created.ok) return created;
    return textResult(context, `✅ Treinador *${trainerName}* criado.\n\nAgora use \`$regioes\`.`, {
      type: "PLAYER",
      id: resolved.value.playerId,
    });
  };

  const regions: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const options = await dependencies.reads.listRegionOptions(player.value);
    if (options.length === 0)
      return err(appError("ACTION_INVALID", "Nenhuma região está disponível para este treinador."));
    const lines = options.map((option, index) => `${index + 1}. ${option.displayName}`);
    return textResult(
      context,
      `🗺️ *REGIÕES*\n\n${lines.join("\n")}\n\nEscolha com \`$regiao <número>\`.`,
    );
  };

  const selectRegion: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const index = Number(commandArgs(context)[0]);
    const options = await dependencies.reads.listRegionOptions(player.value);
    if (!Number.isSafeInteger(index) || index < 1 || index > options.length) {
      return err(appError("VALIDATION_FAILED", "Região inválida. Veja as opções com $regioes."));
    }
    const selected = options[index - 1];
    if (selected === undefined) return err(appError("ACTION_INVALID", "Região não encontrada."));
    const result = await dependencies.registration.selectRegion(player.value, {
      regionId: selected.regionId,
    });
    if (!result.ok) return result;
    return textResult(
      context,
      `✅ Região definida: *${selected.displayName}*.\n\nUse \`$starters\` para ver seus iniciais.`,
    );
  };

  const starters: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const options = await dependencies.starter.listStarterOptions(player.value);
    if (!options.ok) return options;
    const lines = options.value.map(
      (option, index) => `${index + 1}. ${option.displayName} · Nv. ${option.starterLevel}`,
    );
    return textResult(
      context,
      `🔥 *POKÉMON INICIAIS*\n\n${lines.join("\n")}\n\nEscolha com \`$starter <número>\`.`,
    );
  };

  const chooseStarter: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const index = Number(commandArgs(context)[0]);
    const prepared = await dependencies.starter.prepareStarterSelection(player.value);
    if (!prepared.ok) return prepared;
    const selected = prepared.value.options[index - 1];
    if (!Number.isSafeInteger(index) || index < 1 || selected === undefined) {
      return err(appError("VALIDATION_FAILED", "Inicial inválido. Veja as opções com $starters."));
    }
    const correlationId = parseCorrelationId(context.correlationId);
    if (!correlationId.ok) return correlationId;
    const granted = await dependencies.starter.grantStarter(
      player.value,
      { formId: selected.formId },
      correlationId.value,
    );
    if (!granted.ok) return granted;
    const completed = await dependencies.starter.completeOnboarding(player.value);
    if (!completed.ok) return completed;
    const location = await dependencies.world.ensureInitialLocation({ playerId: player.value });
    if (!location.ok) return location;
    return textResult(
      context,
      `✨ *${selected.displayName}* é seu primeiro Pokémon!\n\n📍 Você começa em *${location.value.areaDisplayName}*.\nUse \`$menu\` para abrir sua central.`,
      { type: "PLAYER", id: player.value },
    );
  };

  const conclude: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const completed = await dependencies.starter.completeOnboarding(player.value);
    if (!completed.ok) return completed;
    const location = await dependencies.world.ensureInitialLocation({ playerId: player.value });
    if (!location.ok) return location;
    return textResult(
      context,
      `✅ Entrada concluída.\n📍 *${location.value.areaDisplayName}*\n\nUse \`$menu\`.`,
    );
  };

  const profile: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const profileView = await dependencies.starter.getProfile(player.value);
    if (!profileView.ok) return profileView;
    const value = profileView.value;
    return textResult(
      context,
      [
        "👤 *PERFIL*",
        "",
        `Treinador: *${value.trainerName ?? "—"}*`,
        `Nível: ${value.trainerLevel}`,
        `Pontos: ${value.progressionPoints}`,
        `Status: ${value.playerStatus}`,
        `Onboarding: ${value.onboardingState}`,
      ].join("\n"),
      { type: "PLAYER", id: player.value },
    );
  };

  const team: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const members = await dependencies.reads.listTeam(player.value);
    const lines = members.map(
      (member) =>
        `${member.slotNo}. *${member.displayName}* · Nv. ${member.level} · HP ${member.currentHp}`,
    );
    return textResult(
      context,
      `⚡ *EQUIPE*\n\n${lines.length === 0 ? "Nenhum Pokémon na equipe." : lines.join("\n")}`,
    );
  };

  const inventory: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const page = pageNumber(commandArgs(context));
    if (!page.ok) return page;
    const items = await dependencies.reads.listInventory(player.value);
    const slice = pageSlice(items, page.value);
    if (items.length > 0 && slice.length === 0)
      return err(appError("VALIDATION_FAILED", "Essa página do inventário não existe."));
    const lines = slice.map((item) => `• ${item.displayName} ×${item.quantity}`);
    return textResult(
      context,
      `🎒 *INVENTÁRIO*\n\n${lines.length === 0 ? "Vazio." : lines.join("\n")}${pageFooter(items.length, page.value, "$inventario")}`,
    );
  };

  const pokedex: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const page = pageNumber(commandArgs(context));
    if (!page.ok) return page;
    const entries = await dependencies.reads.listPokedex(player.value);
    const slice = pageSlice(entries, page.value);
    if (entries.length > 0 && slice.length === 0)
      return err(appError("VALIDATION_FAILED", "Essa página da Pokédex não existe."));
    const lines = slice.map(
      (entry) =>
        `#${String(entry.nationalDex).padStart(4, "0")} ${entry.displayName} · vistos ${entry.seenCount} · capturados ${entry.caughtCount}`,
    );
    return textResult(
      context,
      `📕 *POKÉDEX*\n\n${lines.length === 0 ? "Nenhum registro ainda." : lines.join("\n")}${pageFooter(entries.length, page.value, "$pokedex")}`,
    );
  };

  const where: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const location = await dependencies.world.getLocation(player.value);
    if (!location.ok) return location;
    const routes = location.value.connections.map((connection) =>
      connection.available
        ? `→ ${connection.destinationDisplayName}\n  \`$ir ${connection.destinationSlug} v${location.value.revision}\``
        : `🔒 ${connection.destinationDisplayName}`,
    );
    return textResult(
      context,
      [
        `📍 *${location.value.areaDisplayName}*`,
        location.value.regionDisplayName,
        "",
        "*Rotas:*",
        routes.length === 0 ? "Nenhuma saída disponível." : routes.join("\n"),
      ].join("\n"),
    );
  };

  const travel: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const [destinationSlug, revisionToken] = commandArgs(context);
    const match = revisionToken?.match(/^v(\d+)$/i);
    if (destinationSlug === undefined || match === null || match === undefined) {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Rota inválida ou expirada. Use $onde e escolha uma rota atual.",
        ),
      );
    }
    const expectedRevision = BigInt(match[1] ?? "-1");
    const current = await dependencies.world.getLocation(player.value);
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) {
      return err(
        appError(
          "REVISION_CONFLICT",
          "Essa rota expirou porque sua localização mudou. Use $onde novamente.",
        ),
      );
    }
    const connection = current.value.connections.find(
      (candidate) => candidate.destinationSlug === destinationSlug && candidate.available,
    );
    if (connection === undefined) {
      return err(
        appError("ACTION_INVALID", "Essa rota não está disponível agora. Use $onde novamente."),
      );
    }
    const moved = await dependencies.world.travel({
      playerId: player.value,
      destinationAreaId: connection.destinationAreaId,
      expectedRevision,
      idempotencyKey: context.idempotencyKey,
    });
    if (!moved.ok) return moved;
    return textResult(
      context,
      `📍 Você chegou a *${moved.value.to.areaDisplayName}*.\n\nUse \`$onde\` para ver as rotas daqui.`,
    );
  };

  const encounter: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const active = await dependencies.encounter.activeForPlayer(player.value);
    if (!active.ok) return active;
    const name =
      (await dependencies.reads.speciesDisplayName(
        active.value.contentReleaseId,
        active.value.snapshot.speciesId,
      )) ?? "Pokémon selvagem";
    const guidance =
      active.value.status === "IN_BATTLE"
        ? "A batalha já está ativa: use `$batalha`."
        : "A cena continua sob condução do narrador; o bot não inicia combate automaticamente.";
    return textResult(
      context,
      [
        "🌿 *ENCONTRO ATIVO*",
        "",
        `Pokémon: *${name}* · Nv. ${active.value.snapshot.level}`,
        `HP: ${active.value.snapshot.currentHp}/${active.value.snapshot.maxHp}`,
        `Estado: ${active.value.status}`,
        `Revisão: ${active.value.revision}`,
        "",
        guidance,
      ].join("\n"),
    );
  };

  const battle: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const battleId = await dependencies.reads.activeBattleId(player.value);
    if (battleId === null) return err(appError("NOT_FOUND", "Você não está em uma batalha ativa."));
    const view = await dependencies.battle.forPlayer(battleId, player.value);
    if (!view.ok) return view;
    const state = view.value.state;
    const own = activeCombatant(state, view.value.playerSideNo);
    const opponentSide = state.sides.find(
      (side) => side.sideNo !== view.value.playerSideNo && side.result === null,
    );
    const opponent =
      opponentSide === undefined ? null : activeCombatant(state, opponentSide.sideNo);
    if (own === null)
      return err(appError("ACTION_INVALID", "Batalha ativa sem Pokémon controlável."));
    const moveNames = await dependencies.reads.moveDisplayNames(
      state.contentReleaseId,
      own.moves.map((move) => move.moveId),
    );
    const moveLines = own.moves.map((move) => {
      const pp =
        move.ppCurrent === null || move.maxPp === null
          ? "PP —"
          : `PP ${move.ppCurrent}/${move.maxPp}`;
      return `${move.slotNo}. ${moveNames.get(move.moveId) ?? `Movimento ${move.slotNo}`} · ${pp}`;
    });
    const legal = view.value.legalActions.map(
      (action) => `• ${actionLabel(action, state, moveNames)}`,
    );
    return textResult(
      context,
      [
        `⚔️ *BATALHA · Turno ${state.turnNumber} · v${state.version}*`,
        "",
        `Seu Pokémon · HP ${own.currentHp}/${own.maxHp} · status ${statusLabel(own.majorStatus)}`,
        opponent === null
          ? "Oponente: —"
          : `Oponente · HP ${opponent.currentHp}/${opponent.maxHp} · status ${statusLabel(opponent.majorStatus)}`,
        "",
        "*Movimentos:*",
        moveLines.join("\n"),
        "",
        "*Ações mecanicamente legais agora:*",
        legal.length === 0 ? "Nenhuma." : legal.join("\n"),
        "",
        "A cena narrativa continua livre. Esta tela informa legalidade; ela não substitui a seleção explícita da ação narrativa.",
      ].join("\n"),
    );
  };

  return [
    { command: "menu", handler: new FunctionalHandler(menu) },
    { command: "registrar", handler: new FunctionalHandler(register), rateLimitClass: "SENSITIVE" },
    { command: "regioes", handler: new FunctionalHandler(regions) },
    {
      command: "regiao",
      handler: new FunctionalHandler(selectRegion),
      rateLimitClass: "SENSITIVE",
    },
    { command: "starters", handler: new FunctionalHandler(starters) },
    {
      command: "starter",
      handler: new FunctionalHandler(chooseStarter),
      rateLimitClass: "SENSITIVE",
    },
    { command: "concluir", handler: new FunctionalHandler(conclude), rateLimitClass: "SENSITIVE" },
    { command: "perfil", handler: new FunctionalHandler(profile) },
    { command: "equipe", handler: new FunctionalHandler(team) },
    { command: "inventario", handler: new FunctionalHandler(inventory) },
    { command: "pokedex", handler: new FunctionalHandler(pokedex) },
    { command: "onde", handler: new FunctionalHandler(where) },
    { command: "ir", handler: new FunctionalHandler(travel), rateLimitClass: "SENSITIVE" },
    { command: "encontro", handler: new FunctionalHandler(encounter) },
    { command: "batalha", handler: new FunctionalHandler(battle) },
  ];
}
