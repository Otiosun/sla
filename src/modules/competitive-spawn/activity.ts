import { createHash } from "node:crypto";
import type { IncomingMessage } from "../messaging/contracts.js";

export const COMPETITIVE_ACTIVITY_SCALE = 1_000;
export const COMPETITIVE_ACTIVITY_ACTIVE_WINDOW_MS = 5 * 60_000;
export const COMPETITIVE_ACTIVITY_HALF_DECAY_MS = 15 * 60_000;
export const COMPETITIVE_ACTIVITY_RESET_MS = 30 * 60_000;
export const COMPETITIVE_ACTIVITY_REPEAT_WINDOW_MS = 60_000;

export interface CompetitiveActivityBand {
  readonly minPoints: number;
  readonly maxPoints: number;
}

export function competitiveActivityBand(activeParticipants: number): CompetitiveActivityBand {
  if (activeParticipants <= 1) return { minPoints: 11, maxPoints: 20 };
  if (activeParticipants === 2) return { minPoints: 9, maxPoints: 18 };
  if (activeParticipants <= 5) return { minPoints: 8, maxPoints: 17 };
  return { minPoints: 7, maxPoints: 16 };
}

export function competitiveActivityTargetMilli(activeParticipants: number, roll: number): number {
  if (!Number.isSafeInteger(roll) || roll < 0 || roll >= 10_000) {
    throw new RangeError("Competitive activity target roll must be an integer from 0 to 9999");
  }
  const band = competitiveActivityBand(Math.max(1, activeParticipants));
  const minimum = band.minPoints * COMPETITIVE_ACTIVITY_SCALE;
  const maximum = band.maxPoints * COMPETITIVE_ACTIVITY_SCALE;
  const span = maximum - minimum;
  return minimum + Math.floor((span * roll) / 9_999);
}

function normalizedText(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/gu, " ")
    .trim();
}

export function competitiveActivityFingerprint(
  message: Pick<IncomingMessage, "text" | "mediaRefs">,
): string {
  const media = message.mediaRefs
    .map((entry) => entry.kind)
    .sort()
    .join(",");
  return createHash("sha256")
    .update(`${normalizedText(message.text)}|${media}`)
    .digest("hex");
}

export function competitiveActivityBaseWeightMilli(
  message: Pick<IncomingMessage, "text" | "mediaRefs">,
): number {
  const text = message.text?.trim() ?? "";
  if (/^\/(?:c|catch|capturar)(?:\s|$)/iu.test(text)) return 0;
  if (/^\//u.test(text)) return 400;
  if (/^\$/u.test(text)) return 300;

  let weight = 0;
  if (text.length === 1) weight = 250;
  else if (text.length >= 2 && text.length <= 3) weight = 500;
  else if (text.length >= 4) weight = 1_000;

  for (const media of message.mediaRefs) {
    const mediaWeight =
      media.kind === "STICKER"
        ? 250
        : media.kind === "AUDIO"
          ? 700
          : media.kind === "IMAGE" || media.kind === "VIDEO" || media.kind === "DOCUMENT"
            ? 800
            : 400;
    weight = Math.max(weight, mediaWeight);
  }
  return weight;
}

export interface CompetitiveActivityCreditInput {
  readonly baseWeightMilli: number;
  readonly activeParticipants: number;
  readonly sinceSameSenderMs: number | null;
  readonly repeatedRecently: boolean;
  readonly senderStreak: number;
}

export function competitiveActivityCreditMilli(input: CompetitiveActivityCreditInput): number {
  if (!Number.isSafeInteger(input.baseWeightMilli) || input.baseWeightMilli <= 0) return 0;
  let multiplier = 1;

  if (input.repeatedRecently) multiplier *= 0.15;

  if (input.sinceSameSenderMs !== null) {
    const solo = input.activeParticipants <= 1;
    if (input.sinceSameSenderMs < 1_500) multiplier *= solo ? 0.45 : 0.1;
    else if (input.sinceSameSenderMs < 3_000) multiplier *= solo ? 0.6 : 0.25;
    else if (input.sinceSameSenderMs < 6_000) multiplier *= solo ? 0.8 : 0.6;
  }

  if (input.activeParticipants >= 2) {
    if (input.senderStreak >= 4) multiplier *= 0.45;
    else if (input.senderStreak === 3) multiplier *= 0.65;
    else if (input.senderStreak === 2) multiplier *= 0.85;
  }

  return Math.max(
    0,
    Math.min(input.baseWeightMilli, Math.floor(input.baseWeightMilli * multiplier)),
  );
}

export function competitiveActivityDecayedProgressMilli(
  progressMilli: number,
  lastActivityAt: Date | null,
  now: Date,
): { readonly progressMilli: number; readonly resetCycle: boolean } {
  if (lastActivityAt === null) return { progressMilli, resetCycle: false };
  const elapsed = Math.max(0, now.getTime() - lastActivityAt.getTime());
  if (elapsed >= COMPETITIVE_ACTIVITY_RESET_MS) return { progressMilli: 0, resetCycle: true };
  if (elapsed >= COMPETITIVE_ACTIVITY_HALF_DECAY_MS) {
    return { progressMilli: Math.floor(progressMilli / 2), resetCycle: false };
  }
  return { progressMilli, resetCycle: false };
}

export interface CompetitiveSpawnActivityObservation {
  readonly progressMilli: number;
  readonly targetMilli: number | null;
  readonly activeParticipants: number;
  readonly creditedMilli: number;
  readonly frozen: "ACTIVE_SPAWN" | "COOLDOWN" | null;
}

export interface CompetitiveSpawnActivityRepository {
  stateForGroup(groupId: string, now: Date): Promise<CompetitiveSpawnActivityObservation>;
  observe(input: {
    readonly communityGroupId: string;
    readonly provider: string;
    readonly externalMessageId: string;
    readonly playerId: string;
    readonly senderRef: string;
    readonly fingerprint: string;
    readonly baseWeightMilli: number;
    readonly targetRoll: number;
    readonly now: Date;
    readonly cooldownMs: number;
  }): Promise<CompetitiveSpawnActivityObservation>;
}
