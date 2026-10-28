import { type PlayerId, parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import { parseMenuNumber } from "../messaging/human-input.js";
import type {
  OperationalEvolutionOptionView,
  OperationalPendingMoveChoiceView,
  OperationalUxReadModel,
} from "../messaging/operational-ux-read-model.js";
import { resolveOwnedPokemonReference } from "../messaging/owned-pokemon-reference.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { WorldServiceSessionService } from "../world-services/session-service.js";
import type { MoveTrainingService, MoveTrainingMethod } from "./move-training-service.js";
import type { ProgressionService } from "./service.js";

export interface ProgressionWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly reads: Pick<
    OperationalUxReadModel,
    "listPendingMoveChoices" | "activeBattleId" | "listOwnedPokemon" | "listEvolutionOptions" | "listLevelLearnset"
  >;
  readonly progression: Pick<ProgressionService, "resolveMoveChoice" | "evolvePokemon">;
  readonly training?: Pick<MoveTrainingService, "options" | "learn">;
  readonly sessions?: Pick<WorldServiceSessionService, "loadActiveSession">;
  readonly encounter?: Pick<EncounterOperationalReadService, "activeForPlayer">;
  readonly world?: Pick<WorldService, "travelLock">;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly handler: Handler) {}
  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.handler(context);
  }
}

function identity(context: MessageHandlerContext): { provider: string; externalId: string } {
  return { provider: context.message.provider, externalId: context.message.senderRef };
}

function commandArgs(context: MessageHandlerContext): readonly string[] {
  return (context.message.text?.trim() ?? "").split(/\s+/).slice(1);
}

function textResult(context: MessageHandlerContext, text: string): Result<MessageHandlerResult> {
  return ok({
    resultRefType: null,
    resultRefId: null,
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

function progressionFailureResult(error: {
  readonly code: string;
  readonly message: string;
}): Result<never> {
  const code =
    error.code === "MOVE_CHOICE_NOT_FOUND" || error.code === "EVOLUTION_NOT_FOUND"
      ? "NOT_FOUND"
      : error.code === "PROGRESSION_INPUT_INVALID"
        ? "VALIDATION_FAILED"
        : "ACTION_INVALID";
  const userMessage =
    error.code === "EVOLUTION_ITEM_MISSING"
      ? "Você não possui mais o item necessário para essa evolução. Use `/evolucao` para atualizar as opções."
      : error.code === "EVOLUTION_NOT_ELIGIBLE"
        ? "Essa evolução não está mais disponível para o Pokémon neste estado. Use `/evolucao` para conferir os requisitos atuais."
        : error.code === "EVOLUTION_NOT_FOUND"
          ? "Não encontrei esse Pokémon para evoluir."
          : error.code === "MOVE_CHOICE_CONFLICT"
            ? "Essa escolha não pode substituir outro golpe. Use `/golpes` e, se o Pokémon já conhece esse movimento, selecione `pular`."
            : null;
  return err(
    appError(code, error.message, {
      progressionCode: error.code,
      ...(userMessage === null ? {} : { userMessage }),
    }),
  );
}

function evolutionRelativeRequirement(
  value: OperationalEvolutionOptionView["relativePhysicalStats"],
): string {
  if (value === "ATTACK_GT_DEFENSE") return "Ataque maior que Defesa";
  if (value === "ATTACK_LT_DEFENSE") return "Ataque menor que Defesa";
  if (value === "ATTACK_EQ_DEFENSE") return "Ataque igual à Defesa";
  return "";
}

/** The mutation contract accepts ITEM+itemId or CONDITION only, not target form.
 * Never offer two commands that resolve to the same trigger but different targets. */
export function manualEvolutionTriggerKey(option: OperationalEvolutionOptionView): string | null {
  if (option.triggerKind === "LEVEL") return null;
  return option.triggerKind === "ITEM" ? `ITEM:${option.itemId ?? "missing"}` : "CONDITION";
}

export function hasAmbiguousManualEvolution(
  options: readonly OperationalEvolutionOptionView[],
  chosen: OperationalEvolutionOptionView,
): boolean {
  const key = manualEvolutionTriggerKey(chosen);
  return key !== null &&
    options.filter((option) => manualEvolutionTriggerKey(option) === key).length > 1;
}

function evolutionOptionLine(
  option: OperationalEvolutionOptionView,
  index: number,
  collectionNo: number,
  ambiguous: boolean,
): readonly string[] {
  if (option.triggerKind === "LEVEL") {
    const relative = evolutionRelativeRequirement(option.relativePhysicalStats);
    return [
      `*${String(index + 1)}. ${option.targetDisplayName}*`,
      `　Nível ${String(option.requiredLevel ?? "—")} · evolução automática${relative.length === 0 ? "" : ` · ${relative}`}`,
    ];
  }
  if (ambiguous) {
    return [
      `*${String(index + 1)}. ${option.targetDisplayName}*`,
      "　_Indisponível: vários destinos usam o mesmo gatilho._",
      "　_A escolha de destino ainda não pode ser diferenciada com segurança._",
    ];
  }
  if (option.triggerKind === "ITEM") {
    const quantity = option.itemQuantity ?? 0n;
    return [
      `*${String(index + 1)}. ${option.targetDisplayName}*`,
      `　${option.itemDisplayName ?? "Item de evolução"} · mochila ×${quantity.toString()}`,
      quantity > 0n
        ? `　→ \`/evoluir #${String(collectionNo)} ${String(index + 1)}\``
        : "　_Item necessário não disponível na mochila._",
    ];
  }
  return [
    `*${String(index + 1)}. ${option.targetDisplayName}*`,
    option.conditionActive === true
      ? "　Condição especial cumprida."
      : "　Condição especial ainda não cumprida.",
    ...(option.conditionActive === true
      ? [`　→ \`/evoluir #${String(collectionNo)} ${String(index + 1)}\``]
      : []),
  ];
}

async function ensureEvolutionMutationClear(
  dependencies: ProgressionWhatsAppDependencies,
  playerId: PlayerId,
): Promise<Result<void>> {
  if ((await dependencies.reads.activeBattleId(playerId)) !== null) {
    return err(
      appError("FLOW_BLOCKED", "Pokémon não pode evoluir durante uma batalha ativa.", {
        userMessage: "Finalize a batalha antes de evoluir um Pokémon.",
      }),
    );
  }

  if (dependencies.encounter !== undefined) {
    const activeEncounter = await dependencies.encounter.activeForPlayer(playerId);
    if (activeEncounter.ok) {
      return err(
        appError("FLOW_BLOCKED", "Pokémon não pode evoluir durante um encontro ativo.", {
          userMessage: "Resolva o encontro atual antes de evoluir um Pokémon.",
        }),
      );
    }
    if (activeEncounter.error.code !== "NOT_FOUND") return err(activeEncounter.error);
  }

  if (dependencies.world !== undefined) {
    const travel = await dependencies.world.travelLock(playerId);
    if (!travel.ok) return err(travel.error);
    if (travel.value !== null) {
      return err(
        appError("FLOW_BLOCKED", "Pokémon não pode evoluir durante uma viagem.", {
          userMessage: "Aguarde o fim da viagem antes de evoluir um Pokémon.",
        }),
      );
    }
  }
  return ok(undefined);
}
export function renderPendingMoveChoices(
  choices: readonly OperationalPendingMoveChoiceView[],
): string {
  if (choices.length === 0) {
    return [
      "✦ *MOVIMENTOS*",
      "",
      "　　　　〔 `SEM PENDÊNCIAS` 〕",
      "",
      "_Nenhum Pokémon está esperando uma decisão de aprendizado._",
    ].join("\n");
  }

  const lines: string[] = ["✦ *MOVIMENTOS · APRENDIZADO*", ""];
  choices.forEach((choice, index) => {
    const known = choice.currentMoves.some((move) => move.moveId === choice.moveId);
    lines.push(
      "*" +
        String(index + 1) +
        ". " +
        choice.pokemonDisplayName +
        "* · Nv. " +
        String(choice.learnLevel),
      known
        ? `　_já conhece_ *${choice.moveDisplayName}*`
        : `　_quer aprender_ *${choice.moveDisplayName}*`,
      "",
    );
    for (const move of choice.currentMoves) {
      lines.push(`　\`${String(move.slotNo)}\`　${move.displayName}`);
    }
    if (known) {
      lines.push(
        "",
        "_Este golpe já está entre os movimentos atuais. Não substitua outro por ele._",
        `　→ \`/aprender ${String(index + 1)} pular\``,
      );
    } else {
      lines.push(
        "",
        `　→ \`/aprender ${String(index + 1)} <1-4>\``,
        `　→ \`/aprender ${String(index + 1)} pular\``,
      );
    }
    if (index < choices.length - 1) lines.push("", "┄┄┄┄┄┄┄┄┄┄", "");
  });
  return lines.join("\n");
}

export function createProgressionWhatsAppRoutes(
  dependencies: ProgressionWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const pendingMoves: Handler = async (context) => {
    const resolvedPlayer = await dependencies.players.resolvePlayer(identity(context));
    if (!resolvedPlayer.ok) return resolvedPlayer;
    const choices = await dependencies.reads.listPendingMoveChoices(resolvedPlayer.value.playerId);
    return textResult(context, renderPendingMoveChoices(choices));
  };

  const resolvePendingMove: Handler = async (context) => {
    const resolvedPlayer = await dependencies.players.resolvePlayer(identity(context));
    if (!resolvedPlayer.ok) return resolvedPlayer;
    const playerId = resolvedPlayer.value.playerId;

    if ((await dependencies.reads.activeBattleId(playerId)) !== null) {
      return err(
        appError("FLOW_BLOCKED", "Movimentos não podem ser alterados durante uma batalha ativa."),
      );
    }

    const args = commandArgs(context);
    const choiceIndex = Number(args[0]);
    const selection = args[1]?.trim().toLocaleLowerCase("pt-BR");
    const choices = await dependencies.reads.listPendingMoveChoices(playerId);
    const choice =
      Number.isSafeInteger(choiceIndex) && choiceIndex >= 1 ? choices[choiceIndex - 1] : undefined;
    if (choice === undefined) {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Escolha inválida. Use `/golpes` para ver as decisões pendentes.",
        ),
      );
    }

    const skip = selection === "pular" || selection === "ignorar";
    let replaceSlotNo: number | null = null;
    if (!skip) {
      const parsedSlot = Number(selection);
      if (
        !Number.isSafeInteger(parsedSlot) ||
        parsedSlot < 1 ||
        parsedSlot > 4 ||
        !choice.currentMoves.some((move) => move.slotNo === parsedSlot)
      ) {
        return err(
          appError(
            "VALIDATION_FAILED",
            "Informe um slot ocupado de 1–4 ou `pular`. Ex.: `/aprender 1 3`.",
          ),
        );
      }
      replaceSlotNo = parsedSlot;
    }

    const correlationId = parseCorrelationId(context.correlationId);
    if (!correlationId.ok) return correlationId;
    const result = await dependencies.progression.resolveMoveChoice({
      choiceId: choice.choiceId,
      playerId,
      replaceSlotNo,
      correlationId: correlationId.value,
    });
    if (!result.ok) return progressionFailureResult(result.error);

    if (result.value.status === "SKIPPED") {
      return textResult(
        context,
        [
          "✦ *APRENDIZADO ENCERRADO*",
          "",
          `*${choice.pokemonDisplayName}* não aprendeu *${choice.moveDisplayName}*.`,
          "",
          "_Os movimentos atuais foram preservados._",
        ].join("\n"),
      );
    }

    const replaced = choice.currentMoves.find(
      (move) => move.slotNo === result.value.replacedSlotNo,
    );
    return textResult(
      context,
      [
        "✦ *NOVO MOVIMENTO*",
        "",
        `*${choice.pokemonDisplayName}* aprendeu *${choice.moveDisplayName}*.`,
        replaced === undefined
          ? `Slot \`${String(result.value.replacedSlotNo ?? "—")}\` atualizado.`
          : "`" +
            String(replaced.slotNo) +
            "`　~" +
            replaced.displayName +
            "~ → *" +
            choice.moveDisplayName +
            "*",
        "",
        "　　　　〔 `APRENDIDO` 〕",
      ].join("\n"),
    );
  };

  const learnsetGuide: Handler = async (context) => {
    const resolved = await dependencies.players.resolvePlayer(identity(context));
    if (!resolved.ok) return resolved;
    const ownedReader = dependencies.reads.listOwnedPokemon;
    const learnsetReader = dependencies.reads.listLevelLearnset;
    if (ownedReader === undefined || learnsetReader === undefined) {
      return err(appError("FEATURE_UNAVAILABLE", "Consulta de aprendizados indisponível."));
    }
    const owned = await ownedReader.call(dependencies.reads, resolved.value.playerId);
    const pokemon = resolveOwnedPokemonReference(owned, commandArgs(context).join(" "));
    if (!pokemon.ok) return pokemon;
    const entries = await learnsetReader.call(
      dependencies.reads, resolved.value.playerId, pokemon.value.pokemonInstanceId,
    );
    const name = pokemon.value.nickname ?? pokemon.value.displayName;
    const past = entries.filter((entry) => entry.learnLevel <= pokemon.value.level);
    const future = entries.filter((entry) => entry.learnLevel > pokemon.value.level);
    const lines = [
      "✦ *𝗔𝗣𝗥𝗘𝗡𝗗𝗜𝗭𝗔𝗗𝗢𝗦*",
      "",
      `◇ *${name}* · Nv. ${String(pokemon.value.level)}`,
      "　_Golpes por nível · catálogo da sua versão_",
      "",
    ];
    if (entries.length === 0) {
      lines.push(
        "_Nenhum golpe por nível foi registrado para esta forma no catálogo atual._",
        "_Não é possível inferir golpes de outra geração._",
      );
      return textResult(context, lines.join("\n"));
    }
    lines.push("◇ *𝗝Á 𝗔𝗟𝗖𝗔𝗡Ç𝗔𝗗𝗢𝗦*");
    if (past.length === 0) lines.push("_Nenhum ainda._");
    for (const entry of past.slice(-6)) {
      lines.push(
        `　Nv. ${String(entry.learnLevel)} · ${entry.moveDisplayName} · ${entry.known ? "equipado" : "não equipado"}`,
      );
    }
    if (past.length > 6) lines.push(`　… e mais ${String(past.length - 6)} registro(s) anteriores.`);
    lines.push("", "◇ *𝗣𝗥Ó𝗫𝗜𝗠𝗢𝗦 𝗡Í𝗩𝗘𝗜𝗦*");
    if (future.length === 0) lines.push("_Nenhuma nova aprendizagem por nível registrada._");
    for (const entry of future.slice(0, 6)) {
      lines.push(`　Nv. ${String(entry.learnLevel)} · ${entry.moveDisplayName}`);
    }
    if (future.length > 6) lines.push(`　… e mais ${String(future.length - 6)} adiante.`);
    lines.push(
      "",
      "_Com vaga livre, o novo golpe é aprendido automaticamente. Com 4 golpes, a escolha fica em /golpes._",
      "_Golpes antigos não equipados não voltam à força: use /reaprender no Centro Pokémon._",
      "`/golpes` · decisões pendentes",
      "`/centropokemon` · onde reaprender",
      `\`/pokemon #${String(pokemon.value.collectionNo)}\` · ficha atual`,
    );
    return textResult(context, lines.join("\n"));
  };

  const trainingMenu = (method: MoveTrainingMethod, execute: boolean): Handler =>
    async (context) => {
      const player = await dependencies.players.resolvePlayer(identity(context));
      if (!player.ok) return player;
      if (dependencies.training === undefined || dependencies.reads.listOwnedPokemon === undefined) {
        return err(appError("FEATURE_UNAVAILABLE", "Sistema de aprendizado ainda indisponível."));
      }
      if (method === "REMINDER") {
        if (dependencies.sessions === undefined) return err(appError("FEATURE_UNAVAILABLE",
          "Consulta do Centro Pokémon indisponível."));
        const visit = await dependencies.sessions.loadActiveSession(player.value.playerId);
        if (!visit.ok) return visit;
        if (visit.value?.serviceKind !== "POKEMON_CENTER") {
          return err(appError("FLOW_BLOCKED",
            "Entre no Centro Pokémon com `/centropokemon` para reaprender movimentos."));
        }
      }

      const args = commandArgs(context);
      const pokemonReference = args[0] ?? "";
      const owned = await dependencies.reads.listOwnedPokemon(player.value.playerId);
      const pokemon = resolveOwnedPokemonReference(owned, pokemonReference);
      if (!pokemon.ok) return pokemon;
      const options = await dependencies.training.options({
        playerId: player.value.playerId,
        pokemonInstanceId: pokemon.value.pokemonInstanceId,
        method,
      });
      if (!options.ok) return options;
      const name = pokemon.value.nickname ?? pokemon.value.displayName;
      const base = method === "TM" ? "ensinar" : "reaprender";
      if (!execute || args.length < 2) {
        const lines = [
          method === "TM" ? "▣ *MÁQUINAS · TM*" : "✦ *REAPRENDIZADO*",
          "",
          `◇ *${name}* · Nv. ${String(pokemon.value.level)}`,
          "",
        ];
        if (options.value.length === 0) {
          lines.push(method === "TM"
            ? "_Nenhuma TM compatível está disponível na sua mochila._"
            : "_Nenhum movimento elegível para reaprender nesta versão._");
        }
        options.value.forEach((entry, index) => {
          const suffix = method === "TM"
            ? ` · ${entry.itemName ?? "TM"} ×${String(entry.itemQuantity ?? 0n)}`
            : "";
          lines.push(`\`${String(index + 1)}\` ${entry.displayName}${suffix}`);
        });
        if (options.value.length > 0) {
          lines.push("", `\`/${base} #${String(pokemon.value.collectionNo)} <opção>\``,
            "_Com quatro golpes, adicione o slot (1–4) a substituir ao final._");
        }
        if (method === "TM") lines.push("Use `/comprar` em um Poké Mart para consultar ofertas publicadas.");
        return textResult(context, lines.join("\n"));
      }
      const number = parseMenuNumber(args[1] ?? "");
      const picked = number === null ? undefined : options.value[number - 1];
      if (picked === undefined) {
        return err(appError("VALIDATION_FAILED",
          `Opção inexistente. Consulte \`/${base} #${String(pokemon.value.collectionNo)}\`.`));
      }
      const requestedSlot = args[2] === undefined ? null : parseMenuNumber(args[2]);
      if (args.length > 3 || (args[2] !== undefined && requestedSlot === null)) {
        return err(appError("VALIDATION_FAILED", "Escolha um slot válido de 1 a 4."));
      }
      const clear = await ensureEvolutionMutationClear(dependencies, player.value.playerId);
      if (!clear.ok) return clear;
      const correlation = parseCorrelationId(context.correlationId);
      if (!correlation.ok) return correlation;
      const taught = await dependencies.training.learn({
        playerId: player.value.playerId,
        pokemonInstanceId: pokemon.value.pokemonInstanceId,
        method,
        moveId: picked.moveId,
        itemId: picked.itemId,
        replaceSlotNo: requestedSlot,
        idempotencyKey: context.idempotencyKey,
        correlationId: correlation.value,
      });
      if (!taught.ok) return taught;
      return textResult(context, [
        "✦ *MOVIMENTO APRENDIDO*",
        "",
        `*${name}* aprendeu *${picked.displayName}*.`,
        `Slot ${String(taught.value.slotNo)}${taught.value.replacedMoveId === null
          ? " · vaga livre" : " · movimento anterior substituído"}.`,
        method === "TM" ? "Uma TM foi consumida." : "Reaprendizado realizado sem custo.",
        "",
        `\`/pokemon #${String(pokemon.value.collectionNo)}\` · conferir movimentos`,
      ].join("\n"));
    };
  const showTms = trainingMenu("TM", false);
  const teachTm = trainingMenu("TM", true);
  const relearn = trainingMenu("REMINDER", true);

  const evolutionInfo: Handler = async (context) => {
    const resolvedPlayer = await dependencies.players.resolvePlayer(identity(context));
    if (!resolvedPlayer.ok) return resolvedPlayer;
    const listOwnedPokemon = dependencies.reads.listOwnedPokemon;
    const listEvolutionOptions = dependencies.reads.listEvolutionOptions;
    if (listOwnedPokemon === undefined || listEvolutionOptions === undefined) {
      return err(
        appError("FEATURE_UNAVAILABLE", "Consulta de evolução ainda não está disponível.", {
          userMessage: "As informações de evolução estão indisponíveis agora.",
        }),
      );
    }

    const rawReference = commandArgs(context).join(" ");
    const owned = await listOwnedPokemon.call(dependencies.reads, resolvedPlayer.value.playerId);
    const pokemon = resolveOwnedPokemonReference(owned, rawReference);
    if (!pokemon.ok) return pokemon;

    const options = await listEvolutionOptions.call(
      dependencies.reads,
      resolvedPlayer.value.playerId,
      pokemon.value.pokemonInstanceId,
    );
    const displayName = pokemon.value.nickname ?? pokemon.value.displayName;
    if (options.length === 0) {
      return textResult(
        context,
        [
          "✦ *EVOLUÇÃO*",
          "",
          `#${String(pokemon.value.collectionNo)} · *${displayName}* · Nv. ${String(pokemon.value.level)}`,
          "",
          "_Nenhuma evolução está disponível para este Pokémon na versão atual._",
        ].join("\n"),
      );
    }

    const lines = [
      "✦ *EVOLUÇÃO*",
      "",
      `#${String(pokemon.value.collectionNo)} · *${displayName}* · Nv. ${String(pokemon.value.level)}`,
      "",
    ];
    options.forEach((option, index) => {
      lines.push(...evolutionOptionLine(
        option, index, pokemon.value.collectionNo,
        hasAmbiguousManualEvolution(options, option),
      ));
      if (index < options.length - 1) lines.push("");
    });
    const overdue = options.filter((option) =>
      option.triggerKind === "LEVEL" &&
      option.requiredLevel !== null &&
      pokemon.value.level >= option.requiredLevel
    );
    if (overdue.length > 0) {
      lines.push(
        "",
        "△ *EVOLUÇÃO ATRASADA DETECTADA*",
        "_Seu Pokémon já atingiu um requisito por nível, mas ainda está na forma anterior._",
        overdue.length === 1
          ? `→ \`/regularizar #${String(pokemon.value.collectionNo)}\` · corrigir sem ganhar XP`
          : "_Múltiplos caminhos exigem verificação antes de corrigir._",
      );
    }
    lines.push(
      "",
      "_Evoluções por nível acontecem automaticamente quando o requisito é atingido._",
    );
    return textResult(context, lines.join("\n"));
  };

  /**
   * A player with an overdue LEVEL evolution can restore it without extra XP.
   * Database service re-checks current form, pinned rules, ownership, and level.
   * No ITEM/CONDITION trigger, no arbitrary choice of form.
   */
  const regularize: Handler = async (context) => {
    const resolved = await dependencies.players.resolvePlayer(identity(context));
    if (!resolved.ok) return resolved;
    const ownedReader = dependencies.reads.listOwnedPokemon;
    const optionsReader = dependencies.reads.listEvolutionOptions;
    if (ownedReader === undefined || optionsReader === undefined) {
      return err(appError("FEATURE_UNAVAILABLE", "Consulta de evolução indisponível."));
    }
    const owned = await ownedReader.call(dependencies.reads, resolved.value.playerId);
    const pokemon = resolveOwnedPokemonReference(owned, commandArgs(context).join(" "));
    if (!pokemon.ok) return pokemon;
    const options = await optionsReader.call(dependencies.reads,
      resolved.value.playerId, pokemon.value.pokemonInstanceId);
    const eligible = options.filter((option) =>
      option.triggerKind === "LEVEL" &&
      option.requiredLevel !== null &&
      pokemon.value.level >= option.requiredLevel);
    if (eligible.length === 0) {
      return textResult(context,
        "◇ *EVOLUÇÃO EM DIA*\n\nNão há evolução por nível atrasada para este Pokémon.");
    }
    if (eligible.length !== 1) {
      return err(appError("FLOW_BLOCKED", "Multiple possible historical evolutions", {
        userMessage: "Há vários caminhos possíveis; nenhum foi escolhido automaticamente. A administração precisa conferir o histórico.",
      }));
    }
    const clear = await ensureEvolutionMutationClear(dependencies, resolved.value.playerId);
    if (!clear.ok) return clear;
    const correlation = parseCorrelationId(context.correlationId);
    if (!correlation.ok) return correlation;
    const result = await dependencies.progression.evolvePokemon({
      playerId: resolved.value.playerId,
      pokemonInstanceId: pokemon.value.pokemonInstanceId,
      trigger: { kind: "LEVEL" },
      idempotencyKey: context.idempotencyKey,
      correlationId: correlation.value,
    });
    if (!result.ok) return progressionFailureResult(result.error);
    return textResult(context, [
      "✦ *EVOLUÇÃO REGULARIZADA*",
      "",
      `*${pokemon.value.nickname ?? pokemon.value.displayName}* → *${eligible[0]?.targetDisplayName ?? "Nova forma"}*`,
      "",
      "Nenhum XP adicional foi necessário. Nenhum item foi consumido.",
      `\`/pokemon #${String(pokemon.value.collectionNo)}\` · ficha atualizada`,
    ].join("\n"));
  };

  const evolve: Handler = async (context) => {
    const resolvedPlayer = await dependencies.players.resolvePlayer(identity(context));
    if (!resolvedPlayer.ok) return resolvedPlayer;
    const playerId = resolvedPlayer.value.playerId;
    const listOwnedPokemon = dependencies.reads.listOwnedPokemon;
    const listEvolutionOptions = dependencies.reads.listEvolutionOptions;
    if (listOwnedPokemon === undefined || listEvolutionOptions === undefined) {
      return err(
        appError("FEATURE_UNAVAILABLE", "Evolução por WhatsApp ainda não está disponível.", {
          userMessage: "A evolução está indisponível agora.",
        }),
      );
    }

    const args = commandArgs(context);
    const optionNo = parseMenuNumber(args.at(-1) ?? "");
    if (optionNo === null || args.length < 2) {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Use `/evoluir <# ou nome> <opção>`. Veja as opções com `/evolucao <# ou nome>`.",
        ),
      );
    }
    const rawReference = args.slice(0, -1).join(" ");
    const owned = await listOwnedPokemon.call(dependencies.reads, playerId);
    const pokemon = resolveOwnedPokemonReference(owned, rawReference);
    if (!pokemon.ok) return pokemon;

    const options = await listEvolutionOptions.call(
      dependencies.reads,
      playerId,
      pokemon.value.pokemonInstanceId,
    );
    const selected = options[optionNo - 1];
    if (selected === undefined) {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Essa opção de evolução não existe. Use `/evolucao <# ou nome>` para atualizar a lista.",
        ),
      );
    }
    if (hasAmbiguousManualEvolution(options, selected)) {
      return err(
        appError("FLOW_BLOCKED", "Evolution target is ambiguous for this trigger", {
          userMessage:
            "Há mais de um destino para esse mesmo gatilho. Essa evolução está bloqueada até o catálogo permitir identificar a escolha com segurança. Nenhum item foi consumido.",
        }),
      );
    }
    if (selected.triggerKind === "LEVEL") {
      return err(
        appError(
          "VALIDATION_FAILED",
          "Evoluções por nível são automáticas e não precisam de confirmação.",
        ),
      );
    }
    if (selected.triggerKind === "ITEM" && (selected.itemQuantity ?? 0n) < 1n) {
      return err(
        appError("ACTION_INVALID", "Required evolution item is unavailable", {
          userMessage: `Você não possui *${selected.itemDisplayName ?? "o item necessário"}* para essa evolução.`,
        }),
      );
    }
    if (selected.triggerKind === "CONDITION" && selected.conditionActive !== true) {
      return err(
        appError("FLOW_BLOCKED", "Evolution condition is not active", {
          userMessage: "A condição especial dessa evolução ainda não foi cumprida.",
        }),
      );
    }

    const clear = await ensureEvolutionMutationClear(dependencies, playerId);
    if (!clear.ok) return clear;
    const correlationId = parseCorrelationId(context.correlationId);
    if (!correlationId.ok) return correlationId;

    const trigger =
      selected.triggerKind === "ITEM"
        ? selected.itemId === null
          ? null
          : ({ kind: "ITEM", itemId: selected.itemId } as const)
        : ({ kind: "CONDITION" } as const);
    if (trigger === null) {
      return err(
        appError("ACTION_INVALID", "Evolution option is missing its item identity", {
          userMessage: "Essa opção de evolução está incompleta no catálogo atual.",
        }),
      );
    }

    const result = await dependencies.progression.evolvePokemon({
      playerId,
      pokemonInstanceId: pokemon.value.pokemonInstanceId,
      idempotencyKey: context.idempotencyKey,
      correlationId: correlationId.value,
      trigger,
    });
    if (!result.ok) return progressionFailureResult(result.error);

    const beforeName = pokemon.value.nickname ?? pokemon.value.displayName;
    return textResult(
      context,
      [
        "✨ *EVOLUÇÃO CONCLUÍDA*",
        "",
        `*${beforeName}* evoluiu para *${selected.targetDisplayName}*.`,
        "",
        `Use \`/pokemon #${String(pokemon.value.collectionNo)}\` para ver a ficha atualizada.`,
      ].join("\n"),
    );
  };

  return [
    { command: "golpes", aliases: ["movimentos"], handler: new FunctionalHandler(pendingMoves) },
    { command: "aprendizados", aliases: ["learnset"], handler: new FunctionalHandler(learnsetGuide) },
    { command: "tms", handler: new FunctionalHandler(showTms) },
    { command: "ensinar", handler: new FunctionalHandler(teachTm), rateLimitClass: "SENSITIVE" },
    { command: "reaprender", handler: new FunctionalHandler(relearn), rateLimitClass: "SENSITIVE" },
    {
      command: "aprender",
      handler: new FunctionalHandler(resolvePendingMove),
      rateLimitClass: "SENSITIVE",
    },
    {
      command: "evolucao",
      aliases: ["evolucoes"],
      handler: new FunctionalHandler(evolutionInfo),
    },
    {
      command: "evoluir",
      handler: new FunctionalHandler(evolve),
      rateLimitClass: "SENSITIVE",
    },
    {
      command: "regularizar",
      handler: new FunctionalHandler(regularize),
      rateLimitClass: "SENSITIVE",
    },
  ];
}
