import { createHash } from "node:crypto";
import type { IncomingMessage } from "../messaging/contracts.js";
import type { CompetitiveSpawnTimeBucket } from "./contracts.js";

export function normalizeCompetitiveSpawnGuess(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[.'’_]+/gu, "")
    .replace(/[-\s]+/gu, " ")
    .replace(/[^\p{L}\p{N} :]/gu, "")
    .trim();
}

export function competitiveSpawnTrigger(
  message: Pick<IncomingMessage, "provider" | "chatRef" | "externalMessageId" | "text">,
  denominator: number,
): boolean {
  if (!Number.isSafeInteger(denominator) || denominator < 1) {
    throw new RangeError("Competitive spawn trigger denominator must be a positive safe integer");
  }
  const text = message.text?.trim() ?? "";
  if (text.length < 2) return false;
  const hash = createHash("sha256")
    .update(`${message.provider}:${message.chatRef}:${message.externalMessageId}`)
    .digest();
  return hash.readUInt32BE(0) % denominator === 0;
}

export function competitiveSpawnTimeBucket(occurredAt: string): CompetitiveSpawnTimeBucket {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return "DAY";
  const hour = date.getHours();
  if (hour >= 5 && hour <= 10) return "MORNING";
  if (hour >= 11 && hour <= 16) return "DAY";
  if (hour >= 17 && hour <= 19) return "EVENING";
  return "NIGHT";
}
