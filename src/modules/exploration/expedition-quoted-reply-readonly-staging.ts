import type { PostgresExpeditionQuotedEncounterProof } from "../../platform/exploration/postgres-expedition-quoted-encounter-proof.js";
import type { PostgresExpeditionIssuedMenuReplyProof } from "../../platform/exploration/postgres-expedition-issued-menu-reply-proof.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageConversationResolver } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";

/**
 * Explicit, staging-only opt-in. Resolves a private numeric quoted reply
 * through registration, durable Outbox/Encounter proof and an immutable
 * server-issued message-to-menu snapshot, but never
 * offers or executes battle, capture, Ball selection or ignore/escape costs.
 *
 * The production WhatsApp runtime MUST NOT register this resolver. Actual
 * actions require a canonical, revision-guarded session and Capture/PvE ports.
 */
export class ExpeditionQuotedReplyReadOnlyStagingResolver implements MessageConversationResolver {
  constructor(
    private readonly players: Pick<PlayerRegistrationService, "resolvePlayer">,
    private readonly proof: Pick<PostgresExpeditionQuotedEncounterProof, "resolve">,
    private readonly encounters: Pick<EncounterOperationalReadService, "activeForPlayer">,
    private readonly issued: Pick<PostgresExpeditionIssuedMenuReplyProof, "resolve">,
  ) {}

  async resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const text = context.message.text?.trim() ?? "";
    // Never treat ordinary bare numbers or unquoted messages as actions.
    if (!/^[0-4]$/u.test(text) || context.message.replyToExternalMessageId === null) {
      return ok(null);
    }
    if (
      context.message.provider !== "baileys" ||
      context.message.chatRef !== context.message.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(context.message.senderRef)
    ) {
      return err(appError("FLOW_BLOCKED", "Only private quoted encounters can be inspected"));
    }

    const identified = await this.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    if (!identified.ok) return identified;
    if (identified.value.state !== "COMPLETE") {
      return err(
        appError("PLAYER_INELIGIBLE", "Complete registration before opening an encounter"),
      );
    }

    const bound = await this.proof.resolve({
      provider: context.message.provider,
      playerId: identified.value.playerId,
      senderRef: context.message.senderRef,
      chatRef: context.message.chatRef,
      replyToExternalMessageId: context.message.replyToExternalMessageId,
    });
    if (!bound.ok) return bound;

    // The quoted encounter must still be the canonical active one. This
    // is a read-time check, NOT a durable menu-version binding: an old quote
    // for the very same unchanged encounter needs a future issued-menu session.
    const active = await this.encounters.activeForPlayer(identified.value.playerId);
    if (
      !active.ok ||
      active.value.playerId !== identified.value.playerId ||
      active.value.encounterId !== bound.value.encounterId ||
      active.value.revision !== bound.value.encounterRevision ||
      active.value.status !== "ENGAGED" ||
      active.value.battleId !== null
    ) {
      return err(appError("FLOW_BLOCKED", "Quoted encounter is no longer the active encounter"));
    }

    const menu = await this.issued.resolve({
      provider: context.message.provider,
      playerId: identified.value.playerId,
      senderRef: context.message.senderRef,
      chatRef: context.message.chatRef,
      replyToExternalMessageId: context.message.replyToExternalMessageId,
    });
    if (!menu.ok) return menu;
    if (
      menu.value.playerId !== identified.value.playerId ||
      menu.value.outcomeId !== bound.value.outcomeId ||
      menu.value.encounterId !== bound.value.encounterId ||
      menu.value.encounterRevision !== active.value.revision
    ) {
      return err(appError("FLOW_BLOCKED", "Quoted menu does not match the active outcome"));
    }
    // 0/1 are not offered or authorized by this technical preview. An index
    // without a frozen server-selected itemId never becomes a Ball action.
    const ballItemId = menu.value.ballItemIds[text];
    if (ballItemId === undefined || !/^[a-f0-9-]{36}$/iu.test(ballItemId)) {
      return err(appError("FLOW_BLOCKED", "Menu choice was not issued for this encounter"));
    }

    // Never expose internal encounter ids or imply that a selected Ball was
    // spent. A harmless private response makes staging UAT observable.
    return ok({
      resultRefType: null,
      resultRefId: null,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.senderRef,
          messageType: "TEXT",
          payload: {
            text: [
              "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*",
              "> _Resposta citada vinculada ao encontro e ao menu correto._",
              "",
              "› _Prévia técnica: a escolha foi reconhecida sem executar nenhuma ação._",
              "› _Batalha, captura e gastos ainda não estão habilitados._",
            ].join("\n"),
          },
          idempotencyKey: `${context.idempotencyKey}:quoted-encounter-preview`,
        },
      ],
    });
  }
}
