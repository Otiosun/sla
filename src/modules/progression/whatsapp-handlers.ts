import { parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { OperationalUxReadModel } from "../messaging/operational-ux-read-model.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { ProgressionService } from "./service.js";

export interface ProgressionWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly reads: Pick<OperationalUxReadModel, "listPendingMoveChoices" | "activeBattleId">;
  readonly progression: Pick<ProgressionService, "resolveMoveChoice">;
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
    error.code === "MOVE_CHOICE_NOT_FOUND"
      ? "NOT_FOUND"
      : error.code === "PROGRESSION_INPUT_INVALID"
        ? "VALIDATION_FAILED"
        : "ACTION_INVALID";
  return err(appError(code, error.message, { progressionCode: error.code }));
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

  return [
    { command: "golpes", aliases: ["movimentos"], handler: new FunctionalHandler(pendingMoves) },
    {
      command: "aprender",
      handler: new FunctionalHandler(resolvePendingMove),
      rateLimitClass: "SENSITIVE",
    },
  ];
}
