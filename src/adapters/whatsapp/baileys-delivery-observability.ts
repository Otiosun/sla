export interface BaileysDeliveryKeyLike {
  readonly remoteJid?: string | null;
  readonly id?: string | null;
  readonly fromMe?: boolean | null;
  readonly participant?: string | null;
}

export interface BaileysReceiptUpdateLike {
  readonly key: BaileysDeliveryKeyLike;
  readonly receipt: Readonly<Record<string, unknown>> & {
    readonly userJid?: string | null;
    readonly receiptTimestamp?: unknown;
    readonly readTimestamp?: unknown;
    readonly playedTimestamp?: unknown;
  };
}

export interface BaileysMessageUpdateLike {
  readonly key: BaileysDeliveryKeyLike;
  readonly update: Readonly<Record<string, unknown>> & {
    readonly status?: unknown;
    readonly messageTimestamp?: unknown;
  };
}

export interface BaileysDeliveryDiagnostic {
  readonly source: "message-receipt.update" | "messages.update";
  readonly destinationRef: string;
  readonly messageId: string;
  readonly ack: "DELIVERED" | "READ" | "PLAYED" | "STATUS_UPDATE" | "UNKNOWN_RECEIPT";
  readonly providerTimestamp: string | number | null;
  readonly status: string | number | null;
}

const BOT_MESSAGE_ID = /^[0-9A-F]{32}$/i;

function diagnosticKey(
  key: BaileysDeliveryKeyLike,
): { readonly destinationRef: string; readonly messageId: string } | null {
  const destinationRef = key.remoteJid;
  const messageId = key.id;
  if (
    typeof destinationRef !== "string" ||
    !destinationRef.endsWith("@g.us") ||
    typeof messageId !== "string" ||
    !BOT_MESSAGE_ID.test(messageId)
  ) {
    return null;
  }
  return { destinationRef, messageId: messageId.toUpperCase() };
}

function scalar(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && "toString" in value) {
    const rendered = String(value);
    return rendered === "[object Object]" ? null : rendered;
  }
  return null;
}

export function messageReceiptDiagnostics(
  updates: readonly BaileysReceiptUpdateLike[],
): readonly BaileysDeliveryDiagnostic[] {
  const diagnostics: BaileysDeliveryDiagnostic[] = [];
  for (const item of updates) {
    const key = diagnosticKey(item.key);
    if (key === null) continue;

    let ack: BaileysDeliveryDiagnostic["ack"] = "UNKNOWN_RECEIPT";
    let providerTimestamp: string | number | null = null;

    if (item.receipt.playedTimestamp !== undefined && item.receipt.playedTimestamp !== null) {
      ack = "PLAYED";
      providerTimestamp = scalar(item.receipt.playedTimestamp);
    } else if (item.receipt.readTimestamp !== undefined && item.receipt.readTimestamp !== null) {
      ack = "READ";
      providerTimestamp = scalar(item.receipt.readTimestamp);
    } else if (
      item.receipt.receiptTimestamp !== undefined &&
      item.receipt.receiptTimestamp !== null
    ) {
      ack = "DELIVERED";
      providerTimestamp = scalar(item.receipt.receiptTimestamp);
    }

    diagnostics.push({
      source: "message-receipt.update",
      destinationRef: key.destinationRef,
      messageId: key.messageId,
      ack,
      providerTimestamp,
      status: null,
    });
  }
  return diagnostics;
}

export function messageUpdateDiagnostics(
  updates: readonly BaileysMessageUpdateLike[],
): readonly BaileysDeliveryDiagnostic[] {
  const diagnostics: BaileysDeliveryDiagnostic[] = [];
  for (const item of updates) {
    const key = diagnosticKey(item.key);
    if (key === null) continue;

    diagnostics.push({
      source: "messages.update",
      destinationRef: key.destinationRef,
      messageId: key.messageId,
      ack: "STATUS_UPDATE",
      providerTimestamp: scalar(item.update.messageTimestamp),
      status: scalar(item.update.status),
    });
  }
  return diagnostics;
}
