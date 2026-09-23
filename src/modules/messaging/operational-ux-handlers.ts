import { type PlayerId, parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { BattleCombatant } from "../battle/contracts.js";
import type { BattleOperationalReadService } from "../battle/operational-read-service.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { WorldService } from "../world/service.js";
import { zhouliaArrivalCaption } from "../world/zhoulia-presentation.js";
import type { PokemonPcStorageService } from "../world-services/pc-storage-service.js";
import type { WorldServiceSessionService } from "../world-services/session-service.js";
import type { WorldServiceMediaCatalog } from "../world-services/whatsapp-handlers.js";
import type { MessageHandlerContext, MessageHandlerResult } from "./contracts.js";
import { normalizeHumanText, parseCollectionNumber, parseMenuNumber } from "./human-input.js";
import type {
  OperationalOwnedPokemonDetailView,
  OperationalOwnedPokemonView,
  OperationalPokemonDetailView,
  OperationalUxReadModel,
} from "./operational-ux-read-model.js";
import { resolveOwnedPokemonReference } from "./owned-pokemon-reference.js";
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
  readonly world: Pick<
    WorldService,
    "ensureInitialLocation" | "getLocation" | "travel" | "replayTravelIfCommitted"
  > &
    Partial<Pick<WorldService, "replayTravelByIdempotency" | "travelLock">>;
  readonly encounter: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly battle: Pick<BattleOperationalReadService, "forPlayer">;
  readonly reads: OperationalUxReadModel;
  readonly pcStorage?: Pick<PokemonPcStorageService, "getStorage" | "move">;
  readonly sessions?: Pick<WorldServiceSessionService, "loadActiveSession">;
  readonly worldMedia?: WorldServiceMediaCatalog;
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

function arrivalResult(
  context: MessageHandlerContext,
  location: { readonly areaSlug: string; readonly areaDisplayName: string },
  firstVisit: boolean,
  media: WorldServiceMediaCatalog | undefined,
): Result<MessageHandlerResult> {
  const caption = zhouliaArrivalCaption(location.areaSlug, firstVisit);
  if (caption === null) {
    return textResult(
      context,
      `📍 Você chegou a *${location.areaDisplayName}*.\n\nUse \`/onde\` para ver as rotas daqui.`,
    );
  }
  const imageUrl = media?.zhouliaVilaArrivalImageUrl?.() ?? null;
  return ok({
    resultRefType: null,
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: imageUrl === null ? "TEXT" : "IMAGE",
        payload: imageUrl === null ? { text: caption } : { imageUrl, caption },
        idempotencyKey: `${context.idempotencyKey}:reply`,
      },
    ],
  });
}

function cooldownText(availableAt: string, now: Date): string {
  const seconds = Math.max(0, Math.ceil((new Date(availableAt).getTime() - now.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `⏳ Você acabou de chegar a *Vila dos Arrozais*.\nAguarde *${minutes}min ${seconds % 60}s* antes de seguir por outra rota.`;
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

function isOwnedPokemonDetail(
  detail: OperationalPokemonDetailView | OperationalOwnedPokemonDetailView,
): detail is OperationalOwnedPokemonDetailView {
  return (
    "collectionNo" in detail && "placementKind" in detail && "boxNo" in detail && "xp" in detail
  );
}

async function resolvePlayer(
  dependencies: OperationalUxDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.registration.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

function travelInProgressText(): string {
  return [
    "🚶 *ROTOM · VIAGEM*",
    "",
    "_Deslocamento em andamento._",
    "",
    "O mapa e os encontros voltam a ficar disponíveis ao final da viagem.",
  ].join("\n");
}

function onboardingMenu(state: string): string {
  if (state === "COMPLETE") {
    return [
      "📟 *ROTOM · MENU*",
      "",
      "`/onde` · local e rotas",
      "`/perfil` · treinador",
      "`/equipe` · equipe atual",
      "`/inventario` · itens",
      "`/pokedex` · registros",
      "`/golpes` · aprendizado de movimentos",
      "`/pescar` · quando houver ponto disponível",
      "`/combate` · regras de combate",
      "",
      "_Explorações são conduzidas em cena pelo narrador._",
      "Cenas comuns continuam livres entre jogadores e narrador.",
    ].join("\n");
  }

  return [
    "🎒 *RECEPÇÃO*",
    "",
    "Sua entrada em Zhoulia ainda está sendo preparada.",
    "Use `/registrar` para começar ou retomar sua ficha de treinador.",
  ].join("\n");
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
  if (status === null) return "—";
  return status.key === "BAD_POISON" ? "TOXIC" : status.key;
}
export function createOperationalUxRoutes(
  dependencies: OperationalUxDependencies,
): readonly CommandRouteDefinition[] {
  const menu: Handler = async (context) => {
    const resolved = await dependencies.registration.resolveOrCreatePlayer(identity(context));
    if (!resolved.ok) return resolved;

    if (resolved.value.state !== "COMPLETE") {
      return textResult(context, onboardingMenu(resolved.value.state), {
        type: "PLAYER",
        id: resolved.value.playerId,
      });
    }

    const playerId = resolved.value.playerId;
    const battleId = await dependencies.reads.activeBattleId(playerId);
    if (battleId !== null) {
      return textResult(
        context,
        [
          "📟 *ROTOM · BATALHA*",
          "",
          "⚔️ `/batalha` · situação atual",
          "📖 `/combate` · regras e comandos",
        ].join("\n"),
        { type: "PLAYER", id: playerId },
      );
    }

    const activeEncounter = await dependencies.encounter.activeForPlayer(playerId);
    if (activeEncounter.ok) {
      return textResult(
        context,
        [
          "📟 *ROTOM · ENCONTRO*",
          "",
          "Há um Pokémon selvagem na cena atual.",
          "",
          "🌿 `/encontro` · ver o encontro",
          "_O narrador conduz o início do combate._",
          "",
          "_O encontro continua sob condução do narrador._",
        ].join("\n"),
        { type: "PLAYER", id: playerId },
      );
    }
    if (activeEncounter.error.code !== "NOT_FOUND") return err(activeEncounter.error);

    if (dependencies.sessions !== undefined) {
      const activeSession = await dependencies.sessions.loadActiveSession(playerId);
      if (!activeSession.ok) return err(activeSession.error);
      if (activeSession.value !== null) {
        const facility =
          activeSession.value.serviceKind === "POKEMART"
            ? [
                "📟 *ROTOM · POKÉ MART*",
                "",
                "🛒 `/pokemart` · painel da loja",
                "💰 `/comprar` · comprar",
                "💵 `/vender` · vender",
                "🚪 `/sair` · sair da instalação",
              ]
            : [
                "📟 *ROTOM · CENTRO POKÉMON*",
                "",
                "❤️ `/centropokemon` · painel do Centro",
                "✨ `/curar` · recuperar a equipe",
                "🖥️ `/pc` · acessar boxes",
                "💬 `/conversar` · falar com Nurse Hana",
                "🚪 `/sair` · sair da instalação",
              ];
        return textResult(context, facility.join("\n"), { type: "PLAYER", id: playerId });
      }
    }

    const travelLockForMenu =
      dependencies.world.travelLock === undefined
        ? ok(null)
        : await dependencies.world.travelLock(playerId);
    if (!travelLockForMenu.ok) return travelLockForMenu;
    if (travelLockForMenu.value !== null) {
      return textResult(context, travelInProgressText(), {
        type: "PLAYER",
        id: playerId,
      });
    }

    const location = await dependencies.world.getLocation(playerId);
    if (!location.ok) return location;
    const pending = await dependencies.reads.listPendingMoveChoices(playerId);
    return textResult(
      context,
      [
        "📟 *ROTOM · MENU*",
        "",
        `📍 *${location.value.areaDisplayName}* · ${location.value.regionDisplayName}`,
        "",
        "*Você pode:*",
        "`/onde` · área, serviços e rotas",
        "`/equipe` · formação atual",
        "`/colecao` · todos os Pokémon",
        "`/pokemon <#>` · ficha individual",
        "`/inventario` · mochila",
        "`/pokedex` · registros",
        ...(pending.length === 0
          ? []
          : [`⚠️ ${String(pending.length)} decisão(ões) de golpe · \`/golpes\``]),
        "",
        "_Explorações são conduzidas em cena pelo narrador._",
      ].join("\n"),
      { type: "PLAYER", id: playerId },
    );
  };

  const register: Handler = async (context) => {
    const resolved = await dependencies.registration.resolveOrCreatePlayer(identity(context));
    if (!resolved.ok) return resolved;
    const trainerName = commandArgs(context).join(" ").trim();
    if (trainerName.length === 0) {
      return err(appError("VALIDATION_FAILED", "Informe o nome: /registrar Seu Nome"));
    }
    const created = await dependencies.registration.createProfile(resolved.value.playerId, {
      trainerName,
      locale: "pt-BR",
    });
    if (!created.ok) return created;
    return textResult(context, `✅ Treinador *${trainerName}* criado.\n\nAgora use \`/regioes\`.`, {
      type: "PLAYER",
      id: resolved.value.playerId,
    });
  };

  const regions: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const options = await dependencies.reads.listRegionOptions(player.value);
    if (options.length === 0)
      return err(
        appError("FEATURE_UNAVAILABLE", "Nenhuma região está disponível para este treinador.", {
          userMessage: "Nenhuma região está disponível para este treinador no momento.",
        }),
      );
    const lines = options.map((option, index) => `${index + 1}. ${option.displayName}`);
    return textResult(
      context,
      `🗺️ *REGIÕES*\n\n${lines.join("\n")}\n\nEscolha com \`/regiao <número>\`.`,
    );
  };

  const selectRegion: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const index = Number(commandArgs(context)[0]);
    const options = await dependencies.reads.listRegionOptions(player.value);
    if (!Number.isSafeInteger(index) || index < 1 || index > options.length) {
      return err(appError("VALIDATION_FAILED", "Região inválida. Veja as opções com /regioes."));
    }
    const selected = options[index - 1];
    if (selected === undefined)
      return err(
        appError("NOT_FOUND", "Região não encontrada.", {
          userMessage: "Essa região não foi encontrada. Use `/regioes` para atualizar as opções.",
        }),
      );
    const result = await dependencies.registration.selectRegion(player.value, {
      regionId: selected.regionId,
    });
    if (!result.ok) return result;
    return textResult(
      context,
      `✅ Região definida: *${selected.displayName}*.\n\nUse \`/starters\` para ver seus iniciais.`,
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
      `🔥 *POKÉMON INICIAIS*\n\n${lines.join("\n")}\n\nEscolha com \`/starter <número>\`.`,
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
      return err(appError("VALIDATION_FAILED", "Inicial inválido. Veja as opções com /starters."));
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
    const arrival = arrivalResult(
      context,
      location.value,
      location.value.arrival?.firstVisit ?? false,
      dependencies.worldMedia,
    );
    if (!arrival.ok) return arrival;
    return ok({ ...arrival.value, resultRefType: "PLAYER", resultRefId: player.value });
  };

  const conclude: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const completed = await dependencies.starter.completeOnboarding(player.value);
    if (!completed.ok) return completed;
    const location = await dependencies.world.ensureInitialLocation({ playerId: player.value });
    if (!location.ok) return location;
    return arrivalResult(
      context,
      location.value,
      location.value.arrival?.firstVisit ?? false,
      dependencies.worldMedia,
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
        "　_Registro do treinador_",
        "",
        `Treinador: *${value.trainerName ?? "—"}*`,
        `Nível: \`${String(value.trainerLevel)}\``,
        `Insígnias: \`${String(value.progressionPoints)}\``,
        `Status: \`${value.playerStatus}\``,
      ].join("\n"),
      { type: "PLAYER", id: player.value },
    );
  };
  const listOwned = async (playerId: PlayerId) =>
    dependencies.reads.listOwnedPokemon === undefined
      ? null
      : dependencies.reads.listOwnedPokemon(playerId);

  const collection: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const page = pageNumber(commandArgs(context));
    if (!page.ok) return page;
    const owned = await listOwned(player.value);
    if (owned === null) {
      return err(appError("FEATURE_UNAVAILABLE", "Coleção Pokémon ainda não está disponível."));
    }
    const slice = pageSlice(owned, page.value);
    if (owned.length > 0 && slice.length === 0) {
      return err(appError("VALIDATION_FAILED", "Essa página da coleção não existe."));
    }
    const lines = slice.map((pokemon) => {
      const name =
        pokemon.nickname === null || pokemon.nickname.trim().length === 0
          ? pokemon.displayName
          : `${pokemon.nickname} · ${pokemon.displayName}`;
      const placement =
        pokemon.placementKind === "TEAM"
          ? `Equipe ${String(pokemon.slotNo)}`
          : `Box ${String(pokemon.boxNo ?? 1)} · slot ${String(pokemon.slotNo)}`;
      return `#${String(pokemon.collectionNo)}　*${name}* · Nv. ${String(pokemon.level)} · ${placement}`;
    });
    return textResult(
      context,
      [
        "◈ *COLEÇÃO POKÉMON*",
        "",
        lines.length === 0 ? "_Nenhum Pokémon ainda._" : lines.join("\n"),
        pageFooter(owned.length, page.value, "/colecao"),
        "",
        "Abra com `/pokemon <#>`.",
      ].join("\n"),
    );
  };

  const box: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const page = pageNumber(commandArgs(context));
    if (!page.ok) return page;
    const owned = await listOwned(player.value);
    if (owned === null) {
      return err(appError("FEATURE_UNAVAILABLE", "Boxes ainda não estão disponíveis."));
    }
    const stored = owned.filter((pokemon) => pokemon.placementKind === "BOX");
    const slice = pageSlice(stored, page.value);
    if (stored.length > 0 && slice.length === 0) {
      return err(appError("VALIDATION_FAILED", "Essa página da Box não existe."));
    }
    const lines = slice.map(
      (pokemon) =>
        `#${String(pokemon.collectionNo)}　*${pokemon.nickname ?? pokemon.displayName}* · Nv. ${String(pokemon.level)} · Box ${String(pokemon.boxNo ?? 1)}/${String(pokemon.slotNo)}`,
    );
    return textResult(
      context,
      [
        "🗃️ *BOXES*",
        "",
        lines.length === 0 ? "_Nenhum Pokémon armazenado._" : lines.join("\n"),
        pageFooter(stored.length, page.value, "/box"),
      ].join("\n"),
    );
  };

  const ensureRosterMutationClear = async (playerId: PlayerId): Promise<Result<void>> => {
    if ((await dependencies.reads.activeBattleId(playerId)) !== null) {
      return err(
        appError("FLOW_BLOCKED", "A equipe não pode ser reorganizada durante uma batalha.", {
          userMessage: "Finalize a batalha antes de reorganizar sua equipe.",
        }),
      );
    }
    const encounter = await dependencies.encounter.activeForPlayer(playerId);
    if (encounter.ok) {
      return err(
        appError("FLOW_BLOCKED", "A equipe não pode ser reorganizada durante um encontro.", {
          userMessage: "Resolva o encontro atual antes de reorganizar sua equipe.",
        }),
      );
    }
    if (encounter.error.code !== "NOT_FOUND") return err(encounter.error);
    if (dependencies.world.travelLock !== undefined) {
      const travel = await dependencies.world.travelLock(playerId);
      if (!travel.ok) return err(travel.error);
      if (travel.value !== null) {
        return err(
          appError("FLOW_BLOCKED", "A equipe não pode ser reorganizada durante uma viagem.", {
            userMessage: "Aguarde o fim da viagem antes de reorganizar sua equipe.",
          }),
        );
      }
    }
    return ok(undefined);
  };

  const team: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const args = commandArgs(context);
    const owned = await listOwned(player.value);

    if (args.length > 0) {
      if (dependencies.pcStorage === undefined || owned === null) {
        return err(
          appError("FEATURE_UNAVAILABLE", "Gerenciamento da equipe ainda não está disponível."),
        );
      }
      const action = normalizeHumanText(args[0] ?? "");
      if (action !== "colocar" && action !== "guardar") {
        return err(
          appError(
            "VALIDATION_FAILED",
            "Use `/equipe colocar <# ou nome> [slot]` ou `/equipe guardar <# ou nome>`.",
          ),
        );
      }

      const lastArg = args.at(-1) ?? "";
      const explicitSlot =
        action === "colocar" && args.length >= 3 ? parseMenuNumber(lastArg) : null;
      const hasExplicitSlot = explicitSlot !== null && explicitSlot <= 6;
      const referenceParts = hasExplicitSlot ? args.slice(1, -1) : args.slice(1);
      const pokemonRef = resolveOwnedPokemonReference(owned, referenceParts.join(" "));
      if (!pokemonRef.ok) return pokemonRef;
      const pokemon = pokemonRef.value;
      const ref = pokemon.collectionNo;
      const clear = await ensureRosterMutationClear(player.value);
      if (!clear.ok) return clear;
      const storage = await dependencies.pcStorage.getStorage(player.value);
      if (!storage.ok) return storage;

      if (action === "colocar") {
        let slotNo = hasExplicitSlot ? explicitSlot : null;
        if (slotNo === null) {
          const occupied = new Set(storage.value.team.map((entry) => entry.slotNo));
          const free = [1, 2, 3, 4, 5, 6].find((slot) => !occupied.has(slot));
          if (free === undefined) {
            return err(
              appError("VALIDATION_FAILED", "Sua equipe está cheia.", {
                userMessage:
                  "Sua equipe está cheia. Use `/equipe colocar <#> <1-6>` para escolher quem será trocado.",
              }),
            );
          }
          slotNo = free;
        }
        const moved = await dependencies.pcStorage.move({
          playerId: player.value,
          pokemonInstanceId: pokemon.pokemonInstanceId,
          target: { placementKind: "TEAM", boxNo: null, slotNo },
        });
        if (!moved.ok) return moved;
        return textResult(
          context,
          `✅ *Equipe atualizada.*\n\n#${String(ref)} agora está no slot ${String(slotNo)}.\nUse \`/equipe\` para conferir.`,
        );
      }

      if (action === "guardar") {
        const occupied = new Set(
          storage.value.boxes.flatMap((entry) =>
            entry.pokemon.map(
              (boxPokemon) => `${String(entry.boxNo)}:${String(boxPokemon.slotNo)}`,
            ),
          ),
        );
        const maxBox = Math.max(1, ...storage.value.boxes.map((entry) => entry.boxNo));
        let target: { boxNo: number; slotNo: number } | null = null;
        for (let boxNo = 1; boxNo <= maxBox + 1 && target === null; boxNo += 1) {
          for (let slotNo = 1; slotNo <= 30; slotNo += 1) {
            if (!occupied.has(`${String(boxNo)}:${String(slotNo)}`)) {
              target = { boxNo, slotNo };
              break;
            }
          }
        }
        if (target === null) return err(appError("FLOW_BLOCKED", "Não há espaço livre nas Boxes."));
        const moved = await dependencies.pcStorage.move({
          playerId: player.value,
          pokemonInstanceId: pokemon.pokemonInstanceId,
          target: { placementKind: "BOX", boxNo: target.boxNo, slotNo: target.slotNo },
        });
        if (!moved.ok) return moved;
        return textResult(
          context,
          `✅ *Pokémon guardado.*\n\n#${String(ref)} foi para a Box ${String(target.boxNo)}, slot ${String(target.slotNo)}.`,
        );
      }

      return err(
        appError("VALIDATION_FAILED", "Use `/equipe colocar <#> [slot]` ou `/equipe guardar <#>`."),
      );
    }

    if (owned !== null) {
      const members = owned.filter((entry) => entry.placementKind === "TEAM");
      const lines = members.map(
        (member) =>
          `#${String(member.collectionNo)}　*${member.nickname ?? member.displayName}* · Nv. ${String(member.level)} · HP ${String(member.currentHp)} · slot ${String(member.slotNo)}`,
      );
      return textResult(
        context,
        [
          "⚡ *EQUIPE POKÉMON*",
          "",
          lines.length === 0 ? "_Nenhum Pokémon na equipe._" : lines.join("\n"),
          "",
          "`/colecao` · todos os seus Pokémon",
          "`/box` · armazenados",
          "`/pokemon <#>` · ficha individual",
        ].join("\n"),
      );
    }

    const members = await dependencies.reads.listTeam(player.value);
    const lines = members.map(
      (member) =>
        "`" +
        String(member.slotNo) +
        "`　*" +
        member.displayName +
        "* · Nv. " +
        String(member.level) +
        " · HP " +
        String(member.currentHp),
    );
    return textResult(
      context,
      [
        "⚡ *EQUIPE POKÉMON*",
        "",
        lines.length === 0 ? "_Nenhum Pokémon na equipe._" : lines.join("\n"),
      ].join("\n"),
    );
  };

  const pokemonDetail: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const rawReference = commandArgs(context).join(" ");
    const owned = await listOwned(player.value);
    let ref: number;
    if (owned === null) {
      const numericFallback = parseCollectionNumber(rawReference);
      if (numericFallback === null) {
        return err(
          appError(
            "VALIDATION_FAILED",
            "Informe o Pokémon pelo número. Ex.: `/pokemon #1`.",
          ),
        );
      }
      ref = numericFallback;
    } else {
      const resolvedReference = resolveOwnedPokemonReference(owned, rawReference);
      if (!resolvedReference.ok) return resolvedReference;
      ref = resolvedReference.value.collectionNo;
    }

    const detail =
      dependencies.reads.ownedPokemonDetail === undefined
        ? await dependencies.reads.teamPokemonDetail(player.value, ref)
        : await dependencies.reads.ownedPokemonDetail(player.value, ref);
    if (detail === null) {
      return err(appError("NOT_FOUND", "Não existe um Pokémon com esse número na sua coleção."));
    }

    const displayName =
      detail.nickname === null || detail.nickname.trim().length === 0
        ? detail.displayName
        : `${detail.nickname} · ${detail.displayName}`;
    const gender = detail.gender === "MALE" ? "♂" : detail.gender === "FEMALE" ? "♀" : "—";
    const statuses =
      detail.statuses.length === 0
        ? detail.currentHp <= 0
          ? "CAÍDO"
          : "OK"
        : detail.statuses.map((status) => (status === "BAD_POISON" ? "TOXIC" : status)).join(", ");
    const moves = detail.moves.map(
      (move) =>
        "`" +
        String(move.slotNo) +
        "`　*" +
        move.displayName +
        "* · PP " +
        (move.ppCurrent === null || move.maxPp === null
          ? "—"
          : `${String(move.ppCurrent)}/${String(move.maxPp)}`),
    );
    const ownedDetail = isOwnedPokemonDetail(detail) ? detail : null;
    const placement =
      ownedDetail === null
        ? `Equipe · slot ${String(detail.slotNo)}`
        : ownedDetail.placementKind === "TEAM"
          ? `Equipe · slot ${String(ownedDetail.slotNo)}`
          : `Box ${String(ownedDetail.boxNo ?? 1)} · slot ${String(ownedDetail.slotNo)}`;

    return textResult(
      context,
      [
        "◈ *POKÉMON*",
        `　#${String(ref)} · _${displayName}_`,
        "",
        `Nv. \`${String(detail.level)}\`　${gender}${detail.shiny ? "　✦ SHINY" : ""}`,
        `HP　\`${String(detail.currentHp)}/${String(detail.maxHp)}\`　·　\`${statuses}\``,
        ...(ownedDetail === null ? [] : [`XP　\`${ownedDetail.xp.toString()}\``]),
        `Posição: *${placement}*`,
        "",
        `◇ *NATURE*　${detail.natureDisplayName}`,
        `◇ *ABILITY*　${detail.abilityDisplayName}`,
        "",
        "◇ *IVs*",
        `HP \`${String(detail.ivs.hp)}\` · Atk \`${String(detail.ivs.attack)}\` · Def \`${String(detail.ivs.defense)}\``,
        `SpA \`${String(detail.ivs.spAttack)}\` · SpD \`${String(detail.ivs.spDefense)}\` · Spe \`${String(detail.ivs.speed)}\``,
        "",
        "◇ *MOVIMENTOS*",
        ...(moves.length === 0 ? ["_Nenhum movimento._"] : moves),
        "",
        "`/golpes` · decisões de aprendizado",
        "`/equipe` · administrar formação",
      ].join("\n"),
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
    const lines = slice.map((item) => `• ${item.displayName} ×${String(item.quantity)}`);
    return textResult(
      context,
      [
        "🎒 *INVENTÁRIO*",
        "　_Itens carregados_",
        "",
        lines.length === 0 ? "_Vazio._" : lines.join("\n"),
        pageFooter(items.length, page.value, "/inventario"),
      ].join("\n"),
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
        "#" +
        String(entry.nationalDex).padStart(4, "0") +
        " " +
        entry.displayName +
        " · vistos " +
        String(entry.seenCount) +
        " · capturados " +
        String(entry.caughtCount),
    );
    return textResult(
      context,
      [
        "📕 *POKÉDEX*",
        "　_Registros de campo_",
        "",
        lines.length === 0 ? "_Nenhum registro ainda._" : lines.join("\n"),
        pageFooter(entries.length, page.value, "/pokedex"),
      ].join("\n"),
    );
  };
  const where: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const travelLockForWhere =
      dependencies.world.travelLock === undefined
        ? ok(null)
        : await dependencies.world.travelLock(player.value);
    if (!travelLockForWhere.ok) return travelLockForWhere;
    if (travelLockForWhere.value !== null) {
      return textResult(context, travelInProgressText());
    }

    const location = await dependencies.world.getLocation(player.value);
    if (!location.ok) return location;

    const routes = location.value.connections.map((connection, index) =>
      connection.available
        ? `${index + 1}. *${connection.destinationDisplayName}*\n   → \`/ir ${index + 1}\``
        : `${index + 1}. 🔒 *${connection.destinationDisplayName}*`,
    );

    return textResult(
      context,
      [
        `📍 *${location.value.areaDisplayName}*`,
        `_${location.value.regionDisplayName}_`,
        "",
        "*Serviços:*",
        ...(location.value.facilities?.length
          ? location.value.facilities.map((facility) =>
              facility === "POKEMON_CENTER"
                ? "🏥 Centro Pokémon · `/centropokemon`"
                : "🛒 Poké Mart · `/pokemart`",
            )
          : ["_Nenhum serviço mecânico nesta área._"]),
        "",
        "*Rotas:*",
        routes.length === 0 ? "Nenhuma saída disponível." : routes.join("\n"),
        "",
        "_Os requisitos bloqueados permanecem ocultos até fazerem sentido na história._",
      ].join("\n"),
    );
  };

  const travel: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    if (dependencies.world.replayTravelByIdempotency !== undefined) {
      const replayed = await dependencies.world.replayTravelByIdempotency({
        playerId: player.value,
        idempotencyKey: context.idempotencyKey,
      });
      if (!replayed.ok) return replayed;
      if (replayed.value !== null) {
        return arrivalResult(
          context,
          replayed.value.to,
          replayed.value.arrival?.firstVisit ?? false,
          dependencies.worldMedia,
        );
      }
    }

    if (dependencies.sessions !== undefined) {
      const activeSession = await dependencies.sessions.loadActiveSession(player.value);
      if (!activeSession.ok) return activeSession;
      if (activeSession.value !== null) {
        return err(
          appError("FLOW_BLOCKED", "Saia da instalação com `/sair` antes de viajar.", {
            activeServiceKind: activeSession.value.serviceKind,
          }),
        );
      }
    }

    const travelLockBeforeMove =
      dependencies.world.travelLock === undefined
        ? ok(null)
        : await dependencies.world.travelLock(player.value);
    if (!travelLockBeforeMove.ok) return travelLockBeforeMove;
    if (travelLockBeforeMove.value !== null) {
      return textResult(context, travelInProgressText());
    }

    const routeNumber = Number(commandArgs(context)[0]);
    const current = await dependencies.world.getLocation(player.value);
    if (!current.ok) return current;

    if (
      !Number.isSafeInteger(routeNumber) ||
      routeNumber < 1 ||
      routeNumber > current.value.connections.length
    ) {
      return err(
        appError("VALIDATION_FAILED", "Rota inválida. Use `/onde` e escolha pelo número mostrado."),
      );
    }

    const connection = current.value.connections[routeNumber - 1];
    if (connection === undefined || !connection.available) {
      return err(
        appError(
          "FLOW_BLOCKED",
          "Essa rota não está disponível agora. Use `/onde` para rever os destinos.",
          {
            userMessage: "Essa rota não está disponível agora. Use `/onde` para rever os destinos.",
          },
        ),
      );
    }

    const moved = await dependencies.world.travel({
      playerId: player.value,
      destinationAreaId: connection.destinationAreaId,
      expectedRevision: current.value.revision,
      idempotencyKey: context.idempotencyKey,
    });

    if (!moved.ok) {
      if (moved.error.code === "ACTION_INVALID") {
        const availableAt = moved.error.details?.availableAt;
        if (typeof availableAt === "string") {
          return textResult(context, cooldownText(availableAt, new Date()));
        }
        return err(
          appError("FLOW_BLOCKED", moved.error.message, {
            userMessage:
              "Essa rota não pode ser usada agora. Use `/onde` para atualizar os destinos.",
          }),
        );
      }
      return moved.error.code === "REVISION_CONFLICT"
        ? err(
            appError(
              "REVISION_CONFLICT",
              "O caminho mudou antes da viagem. Use `/onde` novamente.",
            ),
          )
        : moved;
    }

    const travelLockAfterMove =
      dependencies.world.travelLock === undefined
        ? ok(null)
        : await dependencies.world.travelLock(player.value);
    if (!travelLockAfterMove.ok) return travelLockAfterMove;
    if (travelLockAfterMove.value !== null) {
      return textResult(
        context,
        [
          "🚶 *VIAGEM INICIADA*",
          "",
          `_${moved.value.from.areaDisplayName} → ${moved.value.to.areaDisplayName}_`,
          "",
          "O Rotom libera o mapa e os encontros ao final da viagem.",
        ].join("\n"),
      );
    }

    return arrivalResult(
      context,
      moved.value.to,
      moved.value.arrival?.firstVisit ?? false,
      dependencies.worldMedia,
    );
  };

  const encounter: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const active = await dependencies.encounter.activeForPlayer(player.value);
    if (!active.ok) return active;

    const wilds =
      active.value.wilds === undefined || active.value.wilds.length === 0
        ? [{ wildNo: 1, status: "ACTIVE" as const, snapshot: active.value.snapshot }]
        : active.value.wilds.filter((wild) => wild.status === "ACTIVE");

    const lines = await Promise.all(
      wilds.map(async (wild) => {
        const name =
          (await dependencies.reads.speciesDisplayName(
            active.value.contentReleaseId,
            wild.snapshot.speciesId,
          )) ?? "Pokémon selvagem";
        return wilds.length === 1
          ? [
              `*${name}* · Nv. ${wild.snapshot.level}`,
              `❤️ HP ${wild.snapshot.currentHp}/${wild.snapshot.maxHp}`,
            ]
          : [
              `${wild.wildNo}. *${name}* · Nv. ${wild.snapshot.level}`,
              `   ❤️ HP ${wild.snapshot.currentHp}/${wild.snapshot.maxHp}`,
            ];
      }),
    );

    const guidance =
      active.value.status === "IN_BATTLE"
        ? "⚔️ A batalha já está ativa. Use `/batalha`."
        : "_A cena continua sob condução do narrador._";

    return textResult(
      context,
      [
        wilds.length <= 1 ? "🌿 *ENCONTRO ATIVO*" : "🌿 *ENCONTRO ATIVO · GRUPO*",
        "",
        ...lines.flat(),
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
      return err(
        appError("FLOW_BLOCKED", "Batalha ativa sem Pokémon controlável.", {
          userMessage: "A batalha está ativa, mas você não tem um Pokémon controlável agora.",
        }),
      );

    return textResult(
      context,
      [
        `⚔️ *BATALHA · Turno ${String(state.turnNumber)}*`,
        "",
        "◇ *SEU POKÉMON*",
        "╰─ HP " +
          String(own.currentHp) +
          "/" +
          String(own.maxHp) +
          " · status " +
          statusLabel(own.majorStatus),
        "",
        "◇ *OPONENTE*",
        opponent === null
          ? "╰─ —"
          : "╰─ HP " +
            String(opponent.currentHp) +
            "/" +
            String(opponent.maxHp) +
            " · status " +
            statusLabel(opponent.majorStatus),
        "",
        "`/combate` · comandos e regras",
      ].join("\n"),
    );
  };
  const combatGuide: Handler = async (context) =>
    textResult(
      context,
      [
        "⚔️ *COMBATE*",
        "",
        "A cena é livre. O bot não interpreta a narração; ele lê somente o comando mecânico incluído na mensagem.",
        "",
        "*Movimento*",
        "`/movimento 2`",
        "`/movimento Quick Attack`",
        "",
        "O comando pode estar em qualquer ponto da mensagem. Use apenas uma ação mecânica por mensagem.",
        "",
        "✅ significa que a ação foi aceita e ficou travada para o turno. A primeira ação aceita não pode ser trocada.",
        "",
        "No PVP, o turno só resolve depois que os dois lados enviarem suas ações. O movimento adversário não é revelado antes da resolução.",
        "",
        "`/batalha` · estado atual",
        "`/capturar [Poké Ball]` · PVE",
        "`/fugir` · PVE",
        "`/desistir` · PVP",
      ].join("\n"),
    );

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
    { command: "perfil", allowEmbedded: true, handler: new FunctionalHandler(profile) },
    { command: "equipe", allowEmbedded: true, handler: new FunctionalHandler(team) },
    { command: "colecao", aliases: ["pokemonbox"], handler: new FunctionalHandler(collection) },
    { command: "box", aliases: ["boxes"], handler: new FunctionalHandler(box) },
    {
      command: "pokemon",
      aliases: ["pkm"],
      allowEmbedded: true,
      handler: new FunctionalHandler(pokemonDetail),
    },
    { command: "inventario", allowEmbedded: true, handler: new FunctionalHandler(inventory) },
    { command: "pokedex", allowEmbedded: true, handler: new FunctionalHandler(pokedex) },
    { command: "onde", allowEmbedded: true, handler: new FunctionalHandler(where) },
    {
      command: "ir",
      allowEmbedded: true,
      handler: new FunctionalHandler(travel),
      rateLimitClass: "SENSITIVE",
    },
    { command: "encontro", allowEmbedded: true, handler: new FunctionalHandler(encounter) },
    { command: "batalha", handler: new FunctionalHandler(battle) },
    { command: "combate", allowEmbedded: true, handler: new FunctionalHandler(combatGuide) },
  ];
}
