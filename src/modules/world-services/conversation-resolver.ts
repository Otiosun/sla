import type { PlayerId } from "../../shared-kernel/ids.js";
import { type AppError, ok, type Result } from "../../shared-kernel/result.js";
import type { CommunityChatContext } from "../community/contracts.js";
import type { EconomyService } from "../economy/service.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import {
  isLikelyMechanicalCommand,
  parseBinaryConfirmation,
  parseMenuNumber,
} from "../messaging/human-input.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { WorldServiceSessionRecord } from "./contracts.js";
import {
  isMartCatalogPromptKey,
  martItemByCode,
  martItemByOfferKey,
  martQuantityOfferFromPromptKey,
  parseMartQuantityReply,
} from "./mart-catalog.js";
import type { MartSaleInventoryReader } from "./mart-sale.js";
import {
  isMartSaleListPromptKey,
  martSaleItemByCode,
  martSaleItemByOfferKey,
  martSaleQuantityOfferFromPromptKey,
  parseMartSaleQuantityReply,
} from "./mart-sale.js";
import {
  isPcDepositListPromptKey,
  isPcWithdrawListPromptKey,
  pcDepositConfirmPromptSuffix,
  pcDepositPokemonFromConfirmPromptKey,
  pcStoredPokemonByCode,
  pcTeamPokemonBySlot,
  pcWithdrawConfirmPromptSuffix,
  pcWithdrawPokemonFromConfirmPromptKey,
  previewPcDepositDestination,
} from "./pc-conversation.js";
import { resolvePokemonPcOrganizeReply } from "./pc-organize-resolver.js";
import {
  renderPokemonPcDepositCancelled,
  renderPokemonPcDepositConfirmation,
  renderPokemonPcDepositSuccess,
  renderPokemonPcWithdrawCancelled,
  renderPokemonPcWithdrawConfirmation,
  renderPokemonPcWithdrawSuccess,
} from "./pc-renderer.js";
import type { PokemonPcStorageService } from "./pc-storage-service.js";
import {
  renderCenterEmployeeConversation,
  renderCenterEmployeeContinuation,
  renderCenterHanaConversation,
  renderCenterHanaContinuation,
  renderMartInsufficientFunds,
  renderMartItemSelection,
  renderMartPurchaseSuccess,
  renderMartSaleItemSelection,
  renderMartSaleSuccess,
  renderMartSaleUnavailable,
} from "./renderer.js";
import { qualifiesAsSceneProof } from "./scene-proof.js";
import type { WorldServiceSessionService } from "./session-service.js";

interface CommunityContextResolver {
  resolveChat(input: {
    readonly provider: string;
    readonly chatRef: string;
  }): Promise<CommunityChatContext>;
}

export interface WorldServiceReplyIntentVerifier {
  isExpectedReply(input: {
    readonly provider: string;
    readonly chatRef: string;
    readonly replyToExternalMessageId: string;
    readonly expectedOutboxIdempotencyKey: string;
  }): Promise<boolean>;
}

interface MartEconomyService
  extends Pick<EconomyService, "purchaseQuantity">,
    Partial<
      Pick<EconomyService, "getWalletBalance" | "sellQuantity"> &
        Pick<MartSaleInventoryReader, "listSellableInventory">
    > {}

export interface WorldServiceConversationResolverDependencies {
  readonly community: CommunityContextResolver;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly sessions: Pick<WorldServiceSessionService, "loadActiveSession" | "recordSceneProof">;
  readonly replyIntent: WorldServiceReplyIntentVerifier;
  readonly economy?: MartEconomyService;
  readonly pcStorage?: Pick<PokemonPcStorageService, "getStorage"> &
    Partial<Pick<PokemonPcStorageService, "deposit" | "withdraw" | "organize">>;
}

function identity(message: IncomingMessage): { provider: string; externalId: string } {
  return { provider: message.provider, externalId: message.senderRef };
}

function hasWorldCapability(context: CommunityChatContext): boolean {
  return context.known && context.capabilities.includes("world");
}

function isSceneProofCandidate(message: IncomingMessage): boolean {
  return (
    message.replyToExternalMessageId === null &&
    message.text !== null &&
    !message.text.trim().startsWith("/") &&
    !message.text.trim().startsWith("$") &&
    qualifiesAsSceneProof(message.text)
  );
}

function insufficientWalletRequest(error: AppError): {
  readonly currencyId: string;
  readonly requested: bigint;
} | null {
  if (error.code !== "ACTION_INVALID" || error.message !== "Wallet balance is insufficient") {
    return null;
  }
  const currencyId = error.details?.currencyId;
  const requested = error.details?.requested;
  if (
    typeof currencyId !== "string" ||
    typeof requested !== "string" ||
    !/^[0-9]+$/.test(requested)
  ) {
    return null;
  }
  const parsed = BigInt(requested);
  return parsed > 0n ? { currencyId, requested: parsed } : null;
}

function insufficientInventoryRequest(error: AppError): {
  readonly itemId: string;
  readonly requested: bigint;
} | null {
  if (error.code !== "ACTION_INVALID" || error.message !== "Inventory balance is insufficient") {
    return null;
  }
  const itemId = error.details?.itemId;
  const requested = error.details?.requested;
  if (typeof itemId !== "string" || typeof requested !== "string" || !/^[0-9]+$/.test(requested)) {
    return null;
  }
  const parsed = BigInt(requested);
  return parsed > 0n ? { itemId, requested: parsed } : null;
}

function replyResult(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
  text: string,
  idempotencySuffix: string,
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
        idempotencyKey: `${context.idempotencyKey}:world-service${idempotencySuffix}`,
      },
    ],
  });
}

function feedbackResult(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
  text = "Não entendi essa resposta nesta etapa. Confira as opções da mensagem anterior e tente novamente.",
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
        idempotencyKey: `${context.idempotencyKey}:world-service:feedback`,
      },
    ],
  });
}

function emptyReply(
  context: MessageHandlerContext,
  session: WorldServiceSessionRecord,
): Result<MessageHandlerResult> {
  return feedbackResult(context, session);
}

export class WorldServiceConversationResolver {
  public constructor(private readonly dependencies: WorldServiceConversationResolverDependencies) {}

  private async resolvePlayer(message: IncomingMessage): Promise<Result<PlayerId>> {
    const resolved = await this.dependencies.players.resolvePlayer(identity(message));
    return resolved.ok ? ok(resolved.value.playerId) : resolved;
  }

  private async isExactActivePromptReply(
    message: IncomingMessage,
    session: WorldServiceSessionRecord | null,
  ): Promise<boolean> {
    if (session === null) return false;
    const replyToExternalMessageId = message.replyToExternalMessageId;
    const expectedOutboxIdempotencyKey = session.expectedReplyOutboxIdempotencyKey;
    const expectedExternalMessageId = session.expectedReplyExternalMessageId;
    if (
      replyToExternalMessageId === null ||
      expectedOutboxIdempotencyKey === null ||
      expectedExternalMessageId === null ||
      replyToExternalMessageId !== expectedExternalMessageId
    ) {
      return false;
    }

    return this.dependencies.replyIntent.isExpectedReply({
      provider: message.provider,
      chatRef: message.chatRef,
      replyToExternalMessageId,
      expectedOutboxIdempotencyKey,
    });
  }

  public async admits(message: IncomingMessage): Promise<boolean> {
    const community = await this.dependencies.community.resolveChat({
      provider: message.provider,
      chatRef: message.chatRef,
    });
    if (!hasWorldCapability(community)) return false;

    const player = await this.resolvePlayer(message);
    if (!player.ok) return false;

    const active = await this.dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return false;
    if (await this.isExactActivePromptReply(message, active.value)) return true;
    if (
      active.value !== null &&
      active.value.expectedReplyOutboxIdempotencyKey !== null &&
      message.text !== null &&
      !isLikelyMechanicalCommand(message.text)
    ) {
      return true;
    }

    if (!isSceneProofCandidate(message)) return false;
    const location = await this.dependencies.world.getLocation(player.value);
    return location.ok;
  }

  public async resolve(
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const community = await this.dependencies.community.resolveChat({
      provider: context.message.provider,
      chatRef: context.message.chatRef,
    });
    if (!hasWorldCapability(community)) return ok(null);

    const player = await this.resolvePlayer(context.message);
    if (!player.ok) return ok(null);

    const active = await this.dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    const session = active.value;
    const text = context.message.text;
    const exactPromptReply = await this.isExactActivePromptReply(context.message, session);
    const hasActivePromptInput =
      session !== null &&
      session.expectedReplyOutboxIdempotencyKey !== null &&
      text !== null &&
      !isLikelyMechanicalCommand(text);

    if (hasActivePromptInput) {
      if (session === null || text === null) return ok(null);
      if (context.message.replyToExternalMessageId !== null && !exactPromptReply) {
        return feedbackResult(
          context,
          session,
          "Essa resposta cita uma etapa anterior. Responda à mensagem mais recente do bot ou envie sua escolha sem usar reply.",
        );
      }

      const promptKey = session.expectedReplyOutboxIdempotencyKey;
      if (session.serviceKind === "POKEMART" && promptKey !== null && text !== null) {
        if (isMartSaleListPromptKey(promptKey)) {
          const listReader = this.dependencies.economy?.listSellableInventory;
          if (listReader === undefined) return emptyReply(context, session);
          const sellable = await listReader.call(this.dependencies.economy, session.playerId);
          if (!sellable.ok) return sellable;
          const selected = martSaleItemByCode(sellable.value, text);
          if (selected === null) return emptyReply(context, session);
          return replyResult(
            context,
            session,
            renderMartSaleItemSelection(selected),
            `:mart:sale:quantity:${selected.offerKey}`,
          );
        }

        const saleOfferKey = martSaleQuantityOfferFromPromptKey(promptKey);
        if (saleOfferKey !== null) {
          const listReader = this.dependencies.economy?.listSellableInventory;
          const saleWriter = this.dependencies.economy?.sellQuantity;
          if (listReader === undefined || saleWriter === undefined) return emptyReply(context, session);

          const sellable = await listReader.call(this.dependencies.economy, session.playerId);
          if (!sellable.ok) return sellable;
          const selected = martSaleItemByOfferKey(sellable.value, saleOfferKey);
          if (selected === null) return emptyReply(context, session);
          const quantity = parseMartSaleQuantityReply(text, selected);
          if (quantity === null) return emptyReply(context, session);

          const sold = await saleWriter.call(this.dependencies.economy, {
            playerId: session.playerId,
            offerKey: saleOfferKey,
            quantity,
            idempotencyKey: context.idempotencyKey,
            metadata: {
              sourceType: "WORLD_SERVICE_MART",
              sourceId: session.sessionId,
              reason: "Poké Mart sale",
              actorType: "PLAYER",
              actorId: session.playerId,
              correlationId: context.correlationId,
            },
          });
          if (!sold.ok) {
            const insufficient = insufficientInventoryRequest(sold.error);
            if (insufficient === null || insufficient.itemId !== selected.itemId) return sold;
            return replyResult(
              context,
              session,
              renderMartSaleUnavailable(selected),
              ":mart:sale:unavailable",
            );
          }

          return replyResult(
            context,
            session,
            renderMartSaleSuccess(selected, sold.value),
            ":mart:sale:result",
          );
        }

        if (isMartCatalogPromptKey(promptKey)) {
          const selected = martItemByCode(text);
          if (selected === null) return emptyReply(context, session);
          return replyResult(
            context,
            session,
            renderMartItemSelection(selected),
            `:mart:quantity:${selected.offerKey}`,
          );
        }

        const offerKey = martQuantityOfferFromPromptKey(promptKey);
        if (offerKey !== null) {
          const selected = martItemByOfferKey(offerKey);
          if (selected === null) return emptyReply(context, session);
          const quantity = parseMartQuantityReply(text, selected);
          if (quantity === null || this.dependencies.economy === undefined) {
            return emptyReply(context, session);
          }

          const purchased = await this.dependencies.economy.purchaseQuantity({
            playerId: session.playerId,
            offerKey,
            quantity,
            idempotencyKey: context.idempotencyKey,
            metadata: {
              sourceType: "WORLD_SERVICE_MART",
              sourceId: session.sessionId,
              reason: "Poké Mart purchase",
              actorType: "PLAYER",
              actorId: session.playerId,
              correlationId: context.correlationId,
            },
          });
          if (!purchased.ok) {
            const insufficient = insufficientWalletRequest(purchased.error);
            const balanceReader = this.dependencies.economy.getWalletBalance;
            if (insufficient === null || balanceReader === undefined) return purchased;

            const balance = await balanceReader.call(
              this.dependencies.economy,
              session.playerId,
              insufficient.currencyId,
            );
            if (!balance.ok) return balance;
            return replyResult(
              context,
              session,
              renderMartInsufficientFunds(
                selected,
                quantity,
                balance.value,
                insufficient.requested,
              ),
              ":mart:insufficient",
            );
          }

          return replyResult(
            context,
            session,
            renderMartPurchaseSuccess(selected, purchased.value),
            ":mart:result",
          );
        }
      }

      if (session.serviceKind === "POKEMON_CENTER" && promptKey !== null && text !== null) {
        const organizeReply = await resolvePokemonPcOrganizeReply({
          context,
          session,
          promptKey,
          text,
          pcStorage: this.dependencies.pcStorage,
        });
        if (organizeReply !== null) return organizeReply;

        const withdrawPokemonId = pcWithdrawPokemonFromConfirmPromptKey(promptKey);
        if (withdrawPokemonId !== null) {
          const choice = parseBinaryConfirmation(text);
          if (choice === false) {
            return replyResult(
              context,
              session,
              renderPokemonPcWithdrawCancelled(),
              ":center:pc:withdraw:cancelled",
            );
          }
          if (choice !== true) {
            return feedbackResult(context, session, "Confirme com `1`/sim ou cancele com `2`/não.");
          }

          const withdrawWriter = this.dependencies.pcStorage?.withdraw;
          if (withdrawWriter === undefined) return emptyReply(context, session);
          const withdrawn = await withdrawWriter.call(this.dependencies.pcStorage, {
            playerId: session.playerId,
            pokemonInstanceId: withdrawPokemonId,
          });
          if (!withdrawn.ok) return withdrawn;

          return replyResult(
            context,
            session,
            renderPokemonPcWithdrawSuccess(withdrawn.value),
            ":center:pc:withdraw:result",
          );
        }

        if (isPcWithdrawListPromptKey(promptKey)) {
          const storageReader = this.dependencies.pcStorage?.getStorage;
          if (storageReader === undefined) return emptyReply(context, session);
          const storage = await storageReader.call(this.dependencies.pcStorage, session.playerId);
          if (!storage.ok) return storage;
          const selected = pcStoredPokemonByCode(storage.value, text);
          if (selected === null) return emptyReply(context, session);
          return replyResult(
            context,
            session,
            renderPokemonPcWithdrawConfirmation(selected),
            pcWithdrawConfirmPromptSuffix(selected.pokemonInstanceId),
          );
        }

        const depositPokemonId = pcDepositPokemonFromConfirmPromptKey(promptKey);
        if (depositPokemonId !== null) {
          const choice = parseBinaryConfirmation(text);
          if (choice === false) {
            return replyResult(
              context,
              session,
              renderPokemonPcDepositCancelled(),
              ":center:pc:deposit:cancelled",
            );
          }
          if (choice !== true) {
            return feedbackResult(context, session, "Confirme com `1`/sim ou cancele com `2`/não.");
          }

          const depositWriter = this.dependencies.pcStorage?.deposit;
          if (depositWriter === undefined) return emptyReply(context, session);
          const deposited = await depositWriter.call(this.dependencies.pcStorage, {
            playerId: session.playerId,
            pokemonInstanceId: depositPokemonId,
          });
          if (!deposited.ok) return deposited;

          return replyResult(
            context,
            session,
            renderPokemonPcDepositSuccess(deposited.value),
            ":center:pc:deposit:result",
          );
        }

        if (isPcDepositListPromptKey(promptKey)) {
          const storageReader = this.dependencies.pcStorage?.getStorage;
          if (storageReader === undefined) return emptyReply(context, session);
          const storage = await storageReader.call(this.dependencies.pcStorage, session.playerId);
          if (!storage.ok) return storage;
          const selected = pcTeamPokemonBySlot(storage.value, text);
          if (selected === null) return emptyReply(context, session);
          const destination = previewPcDepositDestination(storage.value);
          return replyResult(
            context,
            session,
            renderPokemonPcDepositConfirmation(selected, destination),
            pcDepositConfirmPromptSuffix(selected.pokemonInstanceId),
          );
        }

        if (promptKey.endsWith(":center:conversation")) {
          const choice = parseMenuNumber(text);
          if (choice === 1) {
            return replyResult(
              context,
              session,
              renderCenterHanaConversation(),
              ":center:conversation:hana",
            );
          }
          if (choice === 2) {
            return replyResult(
              context,
              session,
              renderCenterEmployeeConversation(),
              ":center:conversation:employee",
            );
          }
          return feedbackResult(context, session, "Escolha `1` para Enfermeira Hana ou `2` para o funcionário do Centro.");
        }

        if (promptKey.endsWith(":center:conversation:hana")) {
          return replyResult(
            context,
            session,
            renderCenterHanaContinuation(text),
            ":center:conversation:hana",
          );
        }

        if (promptKey.endsWith(":center:conversation:employee")) {
          return replyResult(
            context,
            session,
            renderCenterEmployeeContinuation(text),
            ":center:conversation:employee",
          );
        }
      }

      return emptyReply(context, session);
    }

    if (!isSceneProofCandidate(context.message)) return ok(null);
    const sceneText = context.message.text;
    if (sceneText === null) return ok(null);

    const location = await this.dependencies.world.getLocation(player.value);
    if (!location.ok) return location;
    const proof = await this.dependencies.sessions.recordSceneProof({
      playerId: player.value,
      areaId: location.value.areaId,
      sourceInboxMessageId: context.inboxMessageId,
      text: sceneText,
    });
    if (!proof.ok) return proof;

    return ok({
      resultRefType: "WORLD_SERVICE_SCENE_PROOF",
      resultRefId: proof.value.proofId,
      outgoing: [],
    });
  }
}
