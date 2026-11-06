import type { Pool } from "pg";
import type { PurchaseResult, SaleResult } from "../../modules/economy/contracts.js";
import { EconomyService } from "../../modules/economy/service.js";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  type IncomingMessage,
  incomingMessageFingerprint,
  incomingMessageIdempotencyKey,
  type MessageHandlerContext,
  type MessageHandlerResult,
} from "../../modules/messaging/contracts.js";
import {
  renderMartPurchaseSuccess,
  renderMartSaleSuccess,
} from "../../modules/world-services/renderer.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { withTransaction } from "../db/transaction.js";
import { economyRepositoryWithinTransaction } from "../economy/postgres-economy-repository.js";

class RejectedTrade extends Error {
  constructor(readonly reason: import("../../shared-kernel/result.js").AppError) {
    super(reason.message);
  }
}

export class PostgresMartTrade {
  constructor(private readonly pool: Pool) {}

  async trade<T extends PurchaseResult | SaleResult>(
    input: Parameters<EconomyService["purchaseQuantity"]>[0],
    apply: (service: EconomyService) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (!expeditionOperationAllowed(input.playerId))
      return err(appError("FLOW_BLOCKED", "Operação indisponível para esta conta."));
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query("SELECT id FROM players WHERE id=$1 FOR UPDATE", [input.playerId]);
        const visit = await client.query<{ revision: string }>(
          `SELECT session.revision::text FROM world_service_sessions session
           JOIN player_locations location ON location.player_id=session.player_id AND location.area_id=session.area_id
           WHERE session.id=$1 AND session.player_id=$2 AND session.state='OPEN' AND session.service_kind='POKEMART'
           FOR UPDATE OF session,location`,
          [input.metadata.sourceId, input.playerId],
        );
        const session = visit.rows[0];
        if (!session)
          return err(appError("FLOW_BLOCKED", "A visita ao Poké Mart não está ativa nesta área."));
        const result = await apply(new EconomyService(economyRepositoryWithinTransaction(client)));
        if (!result.ok) throw new RejectedTrade(result.error);
        if (result.value.replayed) return result;
        const item = await client.query<{ displayName: string }>(
          'SELECT display_name AS "displayName" FROM item_revisions WHERE item_id=$1 AND content_release_id=$2',
          [result.value.itemId, result.value.contentReleaseId],
        );
        if (!item.rows[0]) throw new Error("Committed trade needs a pinned item name");
        const sale = "saleQuantity" in result.value;
        const response = sale
          ? renderMartSaleSuccess(item.rows[0], result.value)
          : renderMartPurchaseSuccess(item.rows[0], result.value);
        await client.query(
          `INSERT INTO world_service_mart_trade_receipts(player_id,idempotency_key,session_id,session_revision,kind,response_text)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [
            input.playerId,
            input.idempotencyKey,
            input.metadata.sourceId,
            session.revision,
            sale ? "SALE" : "PURCHASE",
            response,
          ],
        );
        return result;
      });
    } catch (error) {
      if (error instanceof RejectedTrade) return err(error.reason);
      throw error;
    }
  }

  private async findReceipt(playerId: PlayerId, message: IncomingMessage, inboxId?: string) {
    if (
      !expeditionOperationAllowed(playerId) ||
      message.provider !== "baileys" ||
      !message.text ||
      message.text.trim().startsWith("/")
    )
      return null;
    const found = await this.pool.query<{
      session_id: string;
      session_revision: string;
      prompt_current: boolean;
      kind: string;
      response_text: string;
    }>(
      `SELECT receipt.session_id,receipt.session_revision::text,receipt.kind,receipt.response_text,
              (session.state='OPEN' AND session.revision=receipt.session_revision) AS prompt_current
       FROM inbox_messages inbox
       JOIN player_identities identity ON identity.provider=inbox.provider AND identity.external_id=$4
         AND identity.player_id=$2 AND identity.status='ACTIVE'
       JOIN world_service_mart_trade_receipts receipt ON receipt.player_id=identity.player_id AND receipt.idempotency_key=$3
       JOIN world_service_sessions session ON session.id=receipt.session_id AND session.player_id=receipt.player_id
       WHERE ($1::uuid IS NULL OR (inbox.id=$1 AND inbox.status='PROCESSING'))
         AND inbox.status IN ('FAILED','PROCESSING') AND inbox.provider='baileys'
         AND inbox.payload_hash=$5 AND inbox.external_message_id=$6
         AND inbox.normalized_payload->>'senderRef'=$4 AND inbox.normalized_payload->>'chatRef'=$7`,
      [
        inboxId ?? null,
        playerId,
        incomingMessageIdempotencyKey(message),
        message.senderRef,
        incomingMessageFingerprint(message),
        message.externalMessageId,
        message.chatRef,
      ],
    );
    return found.rows[0] ?? null;
  }

  async admits(playerId: PlayerId, message: IncomingMessage): Promise<boolean> {
    return (await this.findReceipt(playerId, message)) !== null;
  }

  async recover(
    playerId: PlayerId,
    context: MessageHandlerContext,
  ): Promise<Result<MessageHandlerResult | null>> {
    const { message } = context;
    const receipt = await this.findReceipt(playerId, message, context.inboxMessageId);
    if (!receipt) return ok(null);
    const suffix = receipt.kind === "SALE" ? ":mart:sale:result" : ":mart:result";
    return ok({
      resultRefType: "WORLD_SERVICE_REPLY",
      resultRefId: receipt.session_id,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: message.chatRef,
          messageType: "TEXT",
          idempotencyKey: `${context.idempotencyKey}:world-service${suffix}`,
          payload: {
            text: receipt.response_text,
            ...(receipt.prompt_current
              ? {
                  worldServicePrompt: { playerId, expectedRevision: receipt.session_revision },
                }
              : {}),
          },
        },
      ],
    });
  }
}
