import type { CommunityChatContext } from "../community/contracts.js";
import type { EconomyService } from "../economy/service.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { ok, type AppError, type Result } from "../../shared-kernel/result.js";
import type { WorldServiceSessionRecord } from "./contracts.js";
import {
  isMartCatalogPromptKey,
  martItemByCode,
  martItemByOfferKey,
  martQuantityOfferFromPromptKey,
  parseMartQuantityReply,
} from "./mart-catalog.js";
import {
  renderCenterEmployeeConversation,
  renderCenterHanaConversation,
  renderMartInsufficientFunds,
  renderMartItemSelection,
  renderMartPurchaseSuccess,
} from "./renderer.js";
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
    Partial<Pick<EconomyService, "getWalletBalance">> {}

export interface WorldServiceConversationResolverDependencies {
  readonly community: CommunityContextResolver;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly sessions: Pick<WorldServiceSessionService, "loadActiveSession" | "recordSceneProof">;
  readonly replyIntent: WorldServiceReplyIntentVerifier;
  readonly economy?: MartEconomyService;
}

function identity(message: IncomingMessage): { provider: string; externalId: string } {
  return { provider: message.provider, externalId: message.senderRef };
}

function hasWorldCapability(context: CommunityChatContext): boolean {
  return context.known && context.capabilities.includes("world");
}

function nonEmptyLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function isSceneProofCandidate(message: IncomingMessage): boolean {
  return (
    message.replyToExternalMessageId === null &&
    message.text !== null &&
    nonEmptyLineCount(message.text) >= 4
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

function emptyReply(session: WorldServiceSessionRecord): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_REPLY",
    resultRefId: session.sessionId,
    outgoing: [],
  });
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
    if (await this.isExactActivePromptReply(context.message, active.value)) {
      const session = active.value;
      if (session === null) return ok(null);

      const promptKey = session.expectedReplyOutboxIdempotencyKey;
      const text = context.message.text;
      if (session.serviceKind === "POKEMART" && promptKey !== null && text !== null) {
        if (isMartCatalogPromptKey(promptKey)) {
          const selected = martItemByCode(text);
          if (selected === null) return emptyReply(session);
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
          if (selected === null) return emptyReply(session);
          const quantity = parseMartQuantityReply(text, selected);
          if (quantity === null || this.dependencies.economy === undefined) {
            return emptyReply(session);
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

      if (
        session.serviceKind === "POKEMON_CENTER" &&
        promptKey !== null &&
        promptKey.endsWith(":center:conversation") &&
        text !== null
      ) {
        const choice = text.trim();
        if (choice === "1" || choice === "01") {
          return replyResult(
            context,
            session,
            renderCenterHanaConversation(),
            ":center:conversation:hana",
          );
        }
        if (choice === "2" || choice === "02") {
          return replyResult(
            context,
            session,
            renderCenterEmployeeConversation(),
            ":center:conversation:employee",
          );
        }
        return emptyReply(session);
      }

      return emptyReply(session);
    }

    if (!isSceneProofCandidate(context.message)) return ok(null);
    const text = context.message.text;
    if (text === null) return ok(null);

    const location = await this.dependencies.world.getLocation(player.value);
    if (!location.ok) return location;
    const proof = await this.dependencies.sessions.recordSceneProof({
      playerId: player.value,
      areaId: location.value.areaId,
      sourceInboxMessageId: context.inboxMessageId,
      text,
    });
    if (!proof.ok) return proof;

    return ok({
      resultRefType: "WORLD_SERVICE_SCENE_PROOF",
      resultRefId: proof.value.proofId,
      outgoing: [],
    });
  }
}
