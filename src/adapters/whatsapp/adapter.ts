import type { IncomingMessage, PendingOutboxMessage } from "../../modules/messaging/contracts.js";
import type { OutboundMessageAdapter } from "../../modules/messaging/ports.js";

export type WhatsAppIncomingHandler = (message: IncomingMessage) => Promise<void>;
export type WhatsAppProviderConnectionState = "CONNECTED" | "DISCONNECTED";

export interface WhatsAppAdapter extends OutboundMessageAdapter {
  readonly channel: "whatsapp";
  start(onIncoming: WhatsAppIncomingHandler): Promise<void>;
  stop(): Promise<void>;
  send(message: PendingOutboxMessage): Promise<void>;
}

// Provider selection for the concrete adapter. The domain never imports this implementation.
// Baileys is intentionally not imported here; the provider package is added only with the
// concrete adapter after the provider-neutral messaging gate is proven.
export const SELECTED_WHATSAPP_PROVIDER = "baileys" as const;
