import { ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import { parseBinaryConfirmation } from "../messaging/human-input.js";
import type { WorldServiceSessionRecord } from "./contracts.js";
import {
  isPcOrganizeListPromptKey,
  parsePcOrganizeDestinationReply,
  pcOrganizeConfirmationFromPromptKey,
  pcOrganizeConfirmPromptSuffix,
  pcOrganizeDestinationPromptSuffix,
  pcOrganizePokemonFromDestinationPromptKey,
  pcOrganizeStoredPokemonByCode,
  pcOrganizeStoredPokemonById,
} from "./pc-organize-conversation.js";
import {
  renderPokemonPcOrganizeCancelled,
  renderPokemonPcOrganizeConfirmation,
  renderPokemonPcOrganizeDestination,
  renderPokemonPcOrganizeSuccess,
} from "./pc-organize-renderer.js";
import type { PokemonPcStorageService } from "./pc-storage-service.js";

interface PokemonPcOrganizeStorage
  extends Pick<PokemonPcStorageService, "getStorage">,
    Partial<Pick<PokemonPcStorageService, "organize">> {}

function replyResult(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
  text: string,
  suffix: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_REPLY",
    resultRefId: session.sessionId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: {
          text,
          worldServicePrompt: {
            playerId: session.playerId,
            expectedRevision: session.revision.toString(),
          },
        },
        idempotencyKey: `${context.idempotencyKey}:world-service${suffix}`,
      },
    ],
  });
}

function feedbackReply(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
  text: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_REPLY",
    resultRefId: session.sessionId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:world-service:pc-organize-feedback`,
      },
    ],
  });
}

function emptyReply(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
): Result<MessageHandlerResult> {
  return feedbackReply(
    context,
    session,
    "Não entendi essa resposta do PC. Confira a etapa anterior e tente novamente.",
  );
}

export async function resolvePokemonPcOrganizeReply(input: {
  readonly context: MessageHandlerContext;
  readonly session: WorldServiceSessionRecord;
  readonly promptKey: string;
  readonly text: string;
  readonly pcStorage: PokemonPcOrganizeStorage | undefined;
}): Promise<Result<MessageHandlerResult> | null> {
  const confirmation = pcOrganizeConfirmationFromPromptKey(input.promptKey);
  if (confirmation !== null) {
    const choice = parseBinaryConfirmation(input.text);
    if (choice === false) {
      return replyResult(
        input.context,
        input.session,
        renderPokemonPcOrganizeCancelled(),
        ":center:pc:organize:cancelled",
      );
    }
    if (choice !== true) {
      return feedbackReply(
        input.context,
        input.session,
        "Confirme com `1`/sim ou cancele com `2`/não.",
      );
    }
    const organize = input.pcStorage?.organize;
    if (organize === undefined) return emptyReply(input.context, input.session);
    const organized = await organize.call(input.pcStorage, {
      playerId: input.session.playerId,
      pokemonInstanceId: confirmation.pokemonInstanceId,
      boxNo: confirmation.boxNo,
      slotNo: confirmation.slotNo,
    });
    if (!organized.ok) return organized;
    return replyResult(
      input.context,
      input.session,
      renderPokemonPcOrganizeSuccess(organized.value),
      ":center:pc:organize:result",
    );
  }

  const destinationPokemonId = pcOrganizePokemonFromDestinationPromptKey(input.promptKey);
  if (destinationPokemonId !== null) {
    const destination = parsePcOrganizeDestinationReply(input.text);
    if (destination === null) {
      return feedbackReply(
        input.context,
        input.session,
        "Informe o destino como `caixa 1 slot 3`, `1 3` ou `1/3`.",
      );
    }
    const getStorage = input.pcStorage?.getStorage;
    if (getStorage === undefined) return emptyReply(input.context, input.session);
    const storage = await getStorage.call(input.pcStorage, input.session.playerId);
    if (!storage.ok) return storage;
    const pokemon = pcOrganizeStoredPokemonById(storage.value, destinationPokemonId);
    if (pokemon === null) return emptyReply(input.context, input.session);
    return replyResult(
      input.context,
      input.session,
      renderPokemonPcOrganizeConfirmation(pokemon, destination),
      pcOrganizeConfirmPromptSuffix(destinationPokemonId, destination),
    );
  }

  if (!isPcOrganizeListPromptKey(input.promptKey)) return null;
  const getStorage = input.pcStorage?.getStorage;
  if (getStorage === undefined) return emptyReply(input.context, input.session);
  const storage = await getStorage.call(input.pcStorage, input.session.playerId);
  if (!storage.ok) return storage;
  const pokemon = pcOrganizeStoredPokemonByCode(storage.value, input.text);
  if (pokemon === null) return emptyReply(input.context, input.session);
  return replyResult(
    input.context,
    input.session,
    renderPokemonPcOrganizeDestination(pokemon),
    pcOrganizeDestinationPromptSuffix(pokemon.pokemonInstanceId),
  );
}
