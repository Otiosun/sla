import type { CommunityChatContext } from "../community/contracts.js";
import type {
  IncomingMessage,
  MessageHandlerContext,
  MessageHandlerResult,
} from "../messaging/contracts.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { ok, type Result } from "../../shared-kernel/result.js";
import type { WorldServiceSessionRecord } from "./contracts.js";
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

export interface WorldServiceConversationResolverDependencies {
  readonly community: CommunityContextResolver;
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly sessions: Pick<WorldServiceSessionService, "loadActiveSession" | "recordSceneProof">;
  readonly replyIntent: WorldServiceReplyIntentVerifier;
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
      return ok({
        resultRefType: "WORLD_SERVICE_REPLY",
        resultRefId: session.sessionId,
        outgoing: [],
      });
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
