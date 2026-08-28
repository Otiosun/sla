import {
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from "@whiskeysockets/baileys";
import {
  IncomingMessageSchema,
  type IncomingMessage,
  type MediaReference,
} from "../../modules/messaging/contracts.js";

function timestampToIso(timestamp: WAMessage["messageTimestamp"]): string | null {
  if (timestamp === null || timestamp === undefined) return null;

  let seconds: number;
  if (typeof timestamp === "number") {
    seconds = timestamp;
  } else if (typeof timestamp === "string") {
    seconds = Number(timestamp);
  } else if (typeof timestamp === "bigint") {
    seconds = Number(timestamp);
  } else if (typeof timestamp === "object" && "toNumber" in timestamp) {
    const toNumber = timestamp.toNumber;
    if (typeof toNumber !== "function") return null;
    seconds = toNumber.call(timestamp);
  } else {
    return null;
  }

  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function textFromContent(content: WAMessageContent): string | null {
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null;

  return typeof text === "string" ? text : null;
}

function mediaReference(
  externalMessageId: string,
  kind: MediaReference["kind"],
  mimeType: string | null | undefined,
  fileName: string | null | undefined = null,
): MediaReference {
  return {
    providerMediaId: `${externalMessageId}:${kind.toLowerCase()}`,
    kind,
    mimeType: mimeType ?? null,
    fileName: fileName ?? null,
  };
}

function mediaFromContent(content: WAMessageContent, externalMessageId: string): MediaReference[] {
  const media: MediaReference[] = [];
  if (content.imageMessage) {
    media.push(
      mediaReference(externalMessageId, "IMAGE", content.imageMessage.mimetype),
    );
  }
  if (content.videoMessage) {
    media.push(
      mediaReference(externalMessageId, "VIDEO", content.videoMessage.mimetype),
    );
  }
  if (content.audioMessage) {
    media.push(
      mediaReference(externalMessageId, "AUDIO", content.audioMessage.mimetype),
    );
  }
  if (content.documentMessage) {
    media.push(
      mediaReference(
        externalMessageId,
        "DOCUMENT",
        content.documentMessage.mimetype,
        content.documentMessage.fileName,
      ),
    );
  }
  if (content.stickerMessage) {
    media.push(
      mediaReference(externalMessageId, "STICKER", content.stickerMessage.mimetype),
    );
  }
  return media;
}

function replyIdFromContent(content: WAMessageContent): string | null {
  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    null;
  const stanzaId = contextInfo?.stanzaId;
  return typeof stanzaId === "string" && stanzaId.length > 0 ? stanzaId : null;
}

export function normalizeBaileysMessage(message: WAMessage): IncomingMessage | null {
  if (message.key.fromMe) return null;

  const externalMessageId = message.key.id;
  const chatRef = message.key.remoteJid;
  if (!externalMessageId || !chatRef) return null;

  const occurredAt = timestampToIso(message.messageTimestamp);
  if (occurredAt === null) return null;

  const content = normalizeMessageContent(message.message);
  if (content === undefined) return null;

  const text = textFromContent(content);
  const mediaRefs = mediaFromContent(content, externalMessageId);
  if (text === null && mediaRefs.length === 0) return null;

  return IncomingMessageSchema.parse({
    provider: "baileys",
    externalMessageId,
    senderRef: message.key.participant ?? chatRef,
    chatRef,
    occurredAt,
    text,
    mediaRefs,
    replyToExternalMessageId: replyIdFromContent(content),
  });
}
