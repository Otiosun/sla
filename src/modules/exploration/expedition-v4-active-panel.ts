import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { renderWhatsAppNativeReadMore } from "../messaging/whatsapp-native-read-more.js";
import type { ExpeditionMenuChoice } from "./expedition-contextual-menu.js";
import { EXPEDITION_DURATION_MINUTES, expeditionClock } from "./expedition-clock.js";

/**
 * UX V4 shadow presenter. No WhatsApp route, command dispatcher, gameplay
 * authorization, encounter RNG, time debit, or inventory mutation.
 *
 * Only the current server-authorized choices may be supplied by a trusted
 * caller. The renderer does not grant permissions or construct action routes.
 * This module is deliberately NOT connected to the live bot.
 */
export interface ExpeditionV4ActiveInput {
  readonly phase: "ACTIVE";
  readonly period: "DAY" | "NIGHT";
  readonly currentTime: string;
  readonly elapsedMinutes: number;
  readonly choices: readonly ExpeditionMenuChoice[];
  /** U+031D count validated on real WhatsApp clients; 0 disables native fold. */
  readonly combiningCount: number;
  readonly maxCodeUnits?: number;
}

export interface ExpeditionV4ActivePanel {
  readonly visible: string;
  readonly expanded: string;
  readonly text: string;
  readonly padded: boolean;
}

const ACTIVE_INTENTS = new Set<ExpeditionMenuChoice["intent"]>([
  "SEARCH_FREE",
  "SEARCH_TARGET",
  "SEARCH_RESOURCES",
  "BAG",
  "DESTINATIONS",
  "TRAVEL",
  "END",
]);

function timeRemaining(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function safeChoiceLabel(value: string): string {
  return value
    .replace(/[\r\n*_~`<>]/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\u031d/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function renderExpeditionV4ActivePanel(
  input: ExpeditionV4ActiveInput,
): Result<ExpeditionV4ActivePanel> {
  if (
    input.phase !== "ACTIVE" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.currentTime) ||
    !Number.isSafeInteger(input.elapsedMinutes) ||
    input.elapsedMinutes <= 0 ||
    input.elapsedMinutes >= EXPEDITION_DURATION_MINUTES ||
    !["DAY", "NIGHT"].includes(input.period) ||
    input.choices.length === 0
  ) {
    return err(appError("FLOW_BLOCKED", "No canonical ACTIVE expedition view is available"));
  }

  // The displayed clock must match the persisted period/minutes exactly;
  // rendering a caller-invented clock risks misleading a player about costs.
  if (expeditionClock(input.period, input.elapsedMinutes).currentTime !== input.currentTime) {
    return err(appError("FLOW_BLOCKED", "Expedition clock is inconsistent with elapsed minutes"));
  }

  const seen = new Set<number>();
  const options: string[] = [];
  for (const choice of input.choices) {
    const label = safeChoiceLabel(choice.label);
    if (
      !ACTIVE_INTENTS.has(choice.intent) ||
      !Number.isSafeInteger(choice.optionNo) ||
      choice.optionNo < 1 ||
      choice.optionNo > 20 ||
      seen.has(choice.optionNo) ||
      label.length === 0 ||
      label.length > 80
    ) {
      return err(appError("VALIDATION_FAILED", "Invalid current expedition menu"));
    }
    seen.add(choice.optionNo);
    options.push(`${choice.optionNo}. ${label}`);
  }

  const visible = [
    "◇ *𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*",
    `${input.period === "DAY" ? "☀️" : "🌙"} *${input.currentTime}*`,
    `⌛ Restam \`${timeRemaining(EXPEDITION_DURATION_MINUTES - input.elapsedMinutes)}\``,
  ].join("\n");
  const expanded = options.join("\n");
  const rendered = renderWhatsAppNativeReadMore({
    visible,
    expanded,
    combiningCount: input.combiningCount,
    ...(input.maxCodeUnits === undefined ? {} : { maxCodeUnits: input.maxCodeUnits }),
  });
  return ok({ visible, expanded, text: rendered.text, padded: rendered.padded });
}
