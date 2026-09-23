import { parseCorrelationId, type PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import { parseMenuNumber } from "../messaging/human-input.js";
import type {
  OperationalEvolutionOptionView,
  OperationalUxReadModel,
} from "../messaging/operational-ux-read-model.js";
import { resolveOwnedPokemonReference } from "../messaging/owned-pokemon-reference.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { ProgressionService } from "./service.js";

export interface ProgressionWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly reads: Pick<
    OperationalUxReadModel,
    "listPendingMoveChoices" | "activeBattleId" | "listOwnedPokemon" | "listEvolutionOptions"
  >;
  readonly progression: Pick<ProgressionService, "resolveMoveChoice" | "evolvePokemon">;
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

function evolutionOptionLine(
  option: OperationalEvolutionOptionView,
  index: number,
  collectionNo: number,
): readonly string[] {
  if (option.triggerKind === "LEVEL") {
    const relative = evolutionRelativeRequirement(option.relativePhysicalStats);
    return [
      `*${String(index + 1)}. ${option.targetDisplayName}*`,
      `　Nível ${String(option.requiredLevel ?? "—")} · evolução automática${relative.length === 0 ? "" : ` · ${relative}`}`,
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
export function createProgressionWhatsAppRoutes(
  dependencies: ProgressionWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const pendingMoves: Handler = async (context) => {
    const resolvedPlayer = await dependencies.players.resolvePlayer(identity(context));
    if (!resolvedPlayer.ok) return resolvedPlayer;
    const choices = await dependencies.reads.listPendingMoveChoices(resolvedPlayer.value.playerId);

    if (choices.length === 0) {
      return textResult(
        context,
        [
          "✦ *MOVIMENTOS*",
          "",
          "　　　　〔 `SEM PENDÊNCIAS` 〕",
          "",
          "_Nenhum Pokémon está esperando uma decisão de aprendizado._",
        ].join("\n"),
      );
    }

    const lines: string[] = ["✦ *MOVIMENTOS · APRENDIZADO*", ""];
    choices.forEach((choice, index) => {
      lines.push(
        "*" +
          String(index + 1) +
          ". " +
          choice.pokemonDisplayName +
          "* · Nv. " +
          String(choice.learnLevel),
        `　_quer aprender_ *${choice.moveDisplayName}*`,
        "",
      );
      for (const move of choice.currentMoves) {
        lines.push(`　\`${String(move.slotNo)}\`　${move.displayName}`);
      }
      lines.push(
        "",
        `　→ \`/aprender ${String(index + 1)} <1-4>\``,
        `　→ \`/aprender ${String(index + 1)} pular\``,
      );
      if (index < choices.length - 1) lines.push("", "┄┄┄┄┄┄┄┄┄┄", "");
    });
    return textResult(context, lines.join("\n"));
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
      lines.push(...evolutionOptionLine(option, index, pokemon.value.collectionNo));
      if (index < options.length - 1) lines.push("");
    });
    lines.push("", "_Evoluções por nível acontecem automaticamente quando o requisito é atingido._");
    return textResult(context, lines.join("\n"));
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
  ];
}
