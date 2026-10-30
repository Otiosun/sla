import type { PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboxDeliveryPreparation } from "../../modules/messaging/ports.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import type { PostgresIncidentalMenuSnapshots } from "./postgres-incidental-menu-snapshots.js";
import type { PostgresIncidentalMenuReplyBinding } from "./postgres-incidental-menu-reply-binding.js";

/**
 * SHADOW ONLY: OutboxWorker calls prepare() before contacting Baileys.
 * The existing Baileys adapter uses an outbound-message-ID derived
 * deterministically from message.id. Persisting the reply binding before
 * sending closes the provider-ACK -> PostgreSQL crash window. A retry keeps
 * the SAME outbox ID and hence the SAME provider ID.
 *
 * Do not register until /explorar admission, outbox production migrations,
 * a safe content release and WhatsApp UAT have cleared issue #264.
 */
export class IncidentalMenuOutboxDeliveryPreparation implements OutboxDeliveryPreparation {
  public constructor(
    private readonly options: {
      readonly provider: string;
      readonly snapshots: Pick<PostgresIncidentalMenuSnapshots, "findForPlayer">;
      readonly binding: Pick<PostgresIncidentalMenuReplyBinding, "bindDelivered">;
      /** MUST be the same deterministic ID function used by the provider. */
      readonly providerMessageIdFor: (message: PendingOutboxMessage) => string;
    },
  ) {
    if (!/^[a-z0-9_-]{1,30}$/u.test(options.provider)) {
      throw new Error("Invalid incidental outbox provider");
    }
  }

  public async prepare(message: PendingOutboxMessage): Promise<undefined> {
    if (message.channel !== "whatsapp") return undefined;
    const anchor = message.payload.incidentalMenu;
    if (anchor === undefined) return undefined;
    if (typeof anchor !== "object" || anchor === null || Array.isArray(anchor)) {
      throw new Error("Invalid incidental outbox anchor");
    }
    const menuId = "menuId" in anchor ? anchor.menuId : undefined;
    const rawPlayerId = "playerId" in anchor ? anchor.playerId : undefined;
    const playerId = typeof rawPlayerId === "string" ? parsePlayerId(rawPlayerId) : null;
    if (message.messageType !== "TEXT" ||
        typeof menuId !== "string" || !/^[a-f0-9-]{36}$/iu.test(menuId) ||
        playerId === null || !playerId.ok ||
        typeof message.payload.text !== "string" ||
        message.idempotencyKey.trim().length === 0) {
      throw new Error("Unsafe incidental menu outbox message");
    }
    const issued = await this.options.snapshots.findForPlayer(playerId.value, menuId);
    if (!issued.ok || issued.value.menuId !== menuId ||
        issued.value.menu.text !== message.payload.text) {
      throw new Error("Incidental menu text or owner diverges from stored receipt");
    }
    const providerMessageId = this.options.providerMessageIdFor(message);
    if (providerMessageId.length === 0 || providerMessageId.length > 256) {
      throw new Error("Invalid deterministic provider message id");
    }
    const linked = await this.options.binding.bindDelivered({
      playerId: playerId.value,
      menuId,
      message: {
        provider: this.options.provider,
        chatRef: message.destinationRef,
        externalMessageId: providerMessageId,
      },
    });
    if (!linked.ok) {
      throw new Error("Incidental menu binding not durable: " + linked.error.code);
    }
    return undefined;
  }
}
