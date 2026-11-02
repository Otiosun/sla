import type { PostgresExpeditionQuotedEncounterProof } from "../../platform/exploration/postgres-expedition-quoted-encounter-proof.js";
import type { PostgresExpeditionIssuedMenuReplyProof } from "../../platform/exploration/postgres-expedition-issued-menu-reply-proof.js";
import type { PostgresExpeditionCaptureConfirmationRecovery } from "../../platform/exploration/postgres-expedition-capture-confirmation-recovery.js";
import { expeditionCaptureConfirmation } from "./expedition-capture-confirmation.js";
import { parseCorrelationId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { PveBattleStartService } from "../battle/pve-battle-start.js";
import type { CaptureService } from "../capture/service.js";
import type { EncounterOperationalReadService } from "../encounter/operational-read-service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageConversationResolver } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";

/**
 * Explicit staging-only mechanical adapter. Not registered by the operational
 * WhatsApp runtime. NO action is possible using the current READ_ONLY issuer;
 * a future author-approved ACTIONABLE issuer must pin each menu action to its
 * persisted outbound message before this router can perform a game mutation.
 *
 * Capture and battle are delegated to the existing canonical services with
 * the exact Encounter revision/issued Ball ID, never custom probability/RNG.
 */
export class ExpeditionCanonicalChoiceStagingResolver implements MessageConversationResolver {
  constructor(
    private readonly players: Pick<PlayerRegistrationService, "resolvePlayer">,
    private readonly encounterProof: Pick<PostgresExpeditionQuotedEncounterProof, "resolve">,
    private readonly activeEncounters: Pick<EncounterOperationalReadService, "activeForPlayer">,
    private readonly issuedMenu: Pick<PostgresExpeditionIssuedMenuReplyProof, "resolve">,
    private readonly capture: Pick<CaptureService, "attempt">,
    private readonly pve: Pick<PveBattleStartService, "startCanonical">,
    private readonly captureConfirmationRecovery?: Pick<
      PostgresExpeditionCaptureConfirmationRecovery,
      "resolve"
    >,
  ) {}

  async resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const choice = context.message.text?.trim() ?? "";
    if (!/^[1-4]$/u.test(choice) || context.message.replyToExternalMessageId === null) {
      return ok(null);
    }
    const inbound = context.message;
    if (
      inbound.provider !== "baileys" ||
      inbound.chatRef !== inbound.senderRef ||
      !/^[0-9]{5,20}@(s\.whatsapp\.net|lid)$/u.test(inbound.senderRef)
    ) {
      return err(appError("FLOW_BLOCKED", "Mechanical choices require a private issued menu"));
    }

    const identified = await this.players.resolvePlayer({
      provider: inbound.provider,
      externalId: inbound.senderRef,
    });
    if (!identified.ok) return identified;
    if (identified.value.state !== "COMPLETE") {
      return err(appError("PLAYER_INELIGIBLE", "Trainer onboarding is incomplete"));
    }

    // A prior canonical capture may have COMMITTED despite the Inbox/Outbox
    // completion failing. Reconstruct only its already-authorized answer from
    // the exact claimed Inbox + SENT issued menu. Do not reenter a now-stale
    // Encounter, spend a second Ball or require its former ENGAGED status.
    if (this.captureConfirmationRecovery !== undefined && /^[2-4]$/u.test(choice)) {
      const previous = await this.captureConfirmationRecovery.resolve({
        playerId: identified.value.playerId,
        context,
      });
      if (!previous.ok) return previous;
      if (previous.value !== null) {
        return ok(
          expeditionCaptureConfirmation({
            destinationRef: inbound.senderRef,
            encounterId: previous.value.encounterId,
            status: previous.value.status,
            idempotencyKey: context.idempotencyKey,
          }),
        );
      }
    }

    const authorizedInput = {
      provider: "baileys",
      playerId: identified.value.playerId,
      senderRef: inbound.senderRef,
      chatRef: inbound.chatRef,
      replyToExternalMessageId: inbound.replyToExternalMessageId,
    };
    const [bound, menu] = await Promise.all([
      this.encounterProof.resolve(authorizedInput),
      this.issuedMenu.resolve(authorizedInput),
    ]);
    if (!bound.ok) return bound;
    if (!menu.ok) return menu;

    // The current issuer writes READ_ONLY. It is NOT sufficient merely to
    // quote an encounter or to have an item ID present in the snapshot.
    if (menu.value.actionable !== true) {
      return err(appError("FLOW_BLOCKED", "This menu is only a preview, without gameplay actions"));
    }
    if (
      menu.value.playerId !== identified.value.playerId ||
      menu.value.outcomeId !== bound.value.outcomeId ||
      menu.value.encounterId !== bound.value.encounterId ||
      menu.value.encounterRevision !== bound.value.encounterRevision
    ) {
      return err(appError("FLOW_BLOCKED", "Issued action is not bound to the quoted encounter"));
    }

    const active = await this.activeEncounters.activeForPlayer(identified.value.playerId);
    if (
      !active.ok ||
      active.value.playerId !== identified.value.playerId ||
      active.value.encounterId !== bound.value.encounterId ||
      active.value.revision !== menu.value.encounterRevision ||
      active.value.status !== "ENGAGED" ||
      active.value.battleId !== null
    ) {
      return err(appError("FLOW_BLOCKED", "Encounter changed before the selected action"));
    }
    if (choice === "1") {
      if (menu.value.battleEnabled !== true) {
        return err(appError("FLOW_BLOCKED", "This issued menu does not authorize a battle"));
      }
      const started = await this.pve.startCanonical({
        playerId: identified.value.playerId,
        encounterId: active.value.encounterId,
        expectedRevision: active.value.revision,
        status: "ENGAGED",
      });
      if (!started.ok) {
        return err(
          appError("FLOW_BLOCKED", "The canonical PvE start was rejected", {
            battleCode: started.error.code,
          }),
        );
      }
      return ok({
        resultRefType: "BATTLE",
        resultRefId: started.value.start.battleId,
        outgoing: [
          {
            channel: "whatsapp",
            destinationRef: inbound.senderRef,
            messageType: "TEXT",
            payload: {
              text: [
                "⚔️ *𝗥𝗢𝗧𝗢𝗠 · 𝗕𝗔𝗧𝗔𝗟𝗛𝗔*",
                "> _Batalha iniciada pelo encontro autorizado._",
                "› _Use /batalha para acompanhar os turnos._",
              ].join("\n"),
            },
            idempotencyKey: `${context.idempotencyKey}:expedition-canonical-battle`,
          },
        ],
      });
    }

    if (menu.value.captureEnabled !== true) {
      return err(appError("FLOW_BLOCKED", "This issued menu does not authorize capture"));
    }
    const ballItemId = menu.value.ballItemIds[choice];
    if (ballItemId === undefined) {
      return err(appError("FLOW_BLOCKED", "This Ball was not offered in the issued menu"));
    }
    const correlation = parseCorrelationId(context.correlationId);
    if (!correlation.ok) return correlation;

    // The CaptureService owns RNG, actual inventory consumption, Encounter
    // CAS, Pokédex, party placement and idempotent attempt replay.
    const attempt = await this.capture.attempt({
      playerId: identified.value.playerId,
      encounterId: active.value.encounterId,
      expectedEncounterRevision: active.value.revision,
      expectedBattleVersion: null,
      ballItemId,
      idempotencyKey: context.idempotencyKey,
      correlationId: correlation.value,
      causationId: context.causationId,
    });
    if (!attempt.ok) return attempt;
    return ok(
      expeditionCaptureConfirmation({
        destinationRef: inbound.senderRef,
        encounterId: active.value.encounterId,
        status: attempt.value.status,
        idempotencyKey: context.idempotencyKey,
      }),
    );
  }
}
