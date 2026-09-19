import {
  type IncomingMessage,
  IncomingMessageSchema,
  type MediaReference,
} from "../../modules/messaging/contracts.js";
import type {
  BaileysMessageContentLike,
  BaileysMessageLike,
  BaileysTimestampLike,
} from "./baileys-provider-contracts.js";
import { normalizeMessageContent } from "./baileys-runtime.js";

function timestampToIso(timestamp: BaileysTimestampLike): string | null {
  if (timestamp === null || timestamp === undefined) return null;

  let seconds: number;
  if (typeof timestamp === "number") {
    seconds = timestamp;
  } else if (typeof timestamp === "string") {
    seconds = Number(timestamp);
  } else if (typeof timestamp === "bigint") {
    seconds = Number(timestamp);
  } else {
    seconds = timestamp.toNumber();
  }

  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function textFromContent(content: BaileysMessageContentLike): string | null {
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

function mediaFromContent(
  content: BaileysMessageContentLike,
  externalMessageId: string,
): MediaReference[] {
  const media: MediaReference[] = [];
  if (content.imageMessage) {
    media.push(mediaReference(externalMessageId, "IMAGE", content.imageMessage.mimetype));
  }
  if (content.videoMessage) {
    media.push(mediaReference(externalMessageId, "VIDEO", content.videoMessage.mimetype));
  }
  if (content.audioMessage) {
    media.push(mediaReference(externalMessageId, "AUDIO", content.audioMessage.mimetype));
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
    media.push(mediaReference(externalMessageId, "STICKER", content.stickerMessage.mimetype));
  }
  return media;
}

function replyIdFromContent(content: BaileysMessageContentLike): string | null {
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

function canonicalDeviceId(id: string): string {
  return id.replace(/:\d+@/, "@");
}

function isPhoneNumberJid(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(id);
}

function preferredIdentityRef(
  primary: string | null | undefined,
  alternate: string | null | undefined,
): string | null {
  const preferred =
    (isPhoneNumberJid(alternate) ? alternate : null) ??
    (isPhoneNumberJid(primary) ? primary : null) ??
    primary ??
    alternate;

  if (typeof preferred !== "string" || preferred.trim().length === 0) return null;
  return canonicalDeviceId(preferred.trim());
}

function resolveIdentityRef(value: string, aliases: ReadonlyMap<string, string>): string {
  const trimmed = value.trim();
  const canonical = canonicalDeviceId(trimmed);
  const resolved = aliases.get(trimmed) ?? aliases.get(canonical) ?? canonical;
  return canonicalDeviceId(resolved);
}

function mentionsFromContent(
  content: BaileysMessageContentLike,
  aliases: ReadonlyMap<string, string>,
): readonly string[] {
  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    null;
  const mentions = contextInfo?.mentionedJid;
  return Array.isArray(mentions) && mentions.every((entry) => typeof entry === "string")
    ? [
        ...new Set(
          mentions
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => resolveIdentityRef(entry, aliases)),
        ),
      ]
    : [];
}

export function normalizeBaileysMessage(
  message: BaileysMessageLike,
  identityAliases: ReadonlyMap<string, string> = new Map<string, string>(),
): IncomingMessage | null {
  if (message.key.fromMe) return null;

  const externalMessageId = message.key.id;
  const rawChatRef = message.key.remoteJid;
  if (!externalMessageId || !rawChatRef) return null;

  const chatRef = rawChatRef.endsWith("@g.us")
    ? rawChatRef
    : (preferredIdentityRef(rawChatRef, message.key.remoteJidAlt) ?? rawChatRef);

  const rawSenderRef = preferredIdentityRef(
    message.key.participant ?? chatRef,
    message.key.participantAlt ?? message.key.remoteJidAlt,
  );
  if (rawSenderRef === null) return null;

  const senderRef = resolveIdentityRef(rawSenderRef, identityAliases);

  const occurredAt = timestampToIso(message.messageTimestamp);
  if (occurredAt === null) return null;

  const content = normalizeMessageContent(message.message);
  if (content === undefined) return null;

  const text = textFromContent(content);
  const mediaRefs = mediaFromContent(content, externalMessageId);
  if (text === null && mediaRefs.length === 0) return null;

  const normalized = IncomingMessageSchema.safeParse({
    provider: "baileys",
    externalMessageId,
    senderRef,
    chatRef,
    occurredAt,
    text,
    mentions: mentionsFromContent(content, identityAliases),
    mediaRefs,
    replyToExternalMessageId: replyIdFromContent(content),
  });
  return normalized.success ? normalized.data : null;
}
