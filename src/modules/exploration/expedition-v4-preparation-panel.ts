import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { renderWhatsAppNativeReadMore } from "../messaging/whatsapp-native-read-more.js";
import { EXPEDITION_WEEKLY_LIMIT, expeditionClock, type ExpeditionPeriod } from "./expedition-clock.js";
import type { ExpeditionMenuChoice } from "./expedition-contextual-menu.js";
import type { ExpeditionSnapshot } from "./expedition-state.js";

/**
 * Approved V4 presentations for /explorar opening and PREPARING.
 * SHADOW-ONLY: does not register commands, authorize actions, change period,
 * create an expedition, reserve a weekly slot, travel or spend minutes.
 * A trusted caller must supply the current World location and authorized
 * menu options. Rendering is never an authorization to execute a choice.
 */
export interface ExpeditionV4OpeningInput {
  readonly phase: "NONE";
  readonly locationName: string;
  readonly remainingThisWeek: number;
  readonly canPrepareUnderPolicy: true;
  readonly choices: readonly ExpeditionMenuChoice[];
}

export interface ExpeditionV4PreparingInput {
  readonly expedition: ExpeditionSnapshot;
  readonly locationName: string;
  readonly remainingThisWeek: number;
  readonly choices: readonly ExpeditionMenuChoice[];
  /** Device-calibrated U+031D count: zero means full menu, never a fake fold. */
  readonly combiningCount: number;
  readonly maxCodeUnits?: number;
}

export interface ExpeditionV4PresentedPanel {
  readonly visible: string;
  readonly expanded: string;
  readonly text: string;
  readonly padded: boolean;
}

function safeLocation(value: string): string | null {
  const sanitized = value
    .replace(/[\r\n*_~`\/<>]/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\u031d/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.length > 0 && sanitized.length <= 70 &&
    !sanitized.includes("[Ler mais]") ? sanitized : null;
}

function safeMenu(
  choices: readonly ExpeditionMenuChoice[],
  permitted: ReadonlySet<ExpeditionMenuChoice["intent"]>,
): Result<readonly string[]> {
  if (choices.length === 0 || choices.length > 20) {
    return err(appError("FLOW_BLOCKED", "No valid current Rotom action list"));
  }
  const seenNumbers = new Set<number>();
  const seenIntents = new Set<string>();
  const lines: string[] = [];
  for (const choice of choices) {
    if (
      !permitted.has(choice.intent) ||
      !Number.isSafeInteger(choice.optionNo) ||
      choice.optionNo < 1 ||
      choice.optionNo > 20 ||
      seenNumbers.has(choice.optionNo) ||
      seenIntents.has(choice.intent)
    ) {
      return err(appError("VALIDATION_FAILED", "Invalid or repeated expedition action"));
    }
    const label = choice.label
      .replace(/[\r\n*_~`\/<>]/gu, " ")
      .replace(/\p{Cc}/gu, " ")
      .replace(/\u031d/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (label.length === 0 || label.length > 80 ||
      label.includes("[Ler mais]")) {
      return err(appError("VALIDATION_FAILED", "Unsafe expedition action label"));
    }
    seenNumbers.add(choice.optionNo);
    seenIntents.add(choice.intent);
    lines.push(String(choice.optionNo) + ". " + label);
  }
  return ok(lines);
}

const PREPARING_INTENTS: ReadonlySet<ExpeditionMenuChoice["intent"]> = new Set([
  "SEARCH_FREE", "SEARCH_TARGET", "SEARCH_RESOURCES", "DESTINATIONS",
  "CHANGE_PERIOD", "CANCEL_PREPARATION", "TEAM", "BAG",
]);

export function renderExpeditionV4OpeningPanel(
  input: ExpeditionV4OpeningInput,
): Result<ExpeditionV4PresentedPanel> {
  const location = safeLocation(input.locationName);
  if (input.phase !== "NONE" || input.canPrepareUnderPolicy !== true ||
    location === null || !Number.isSafeInteger(input.remainingThisWeek) ||
    input.remainingThisWeek < 1 || input.remainingThisWeek > EXPEDITION_WEEKLY_LIMIT) {
    return err(appError("FLOW_BLOCKED", "Expedition is not eligible for preparation"));
  }
  // No invented period choices: caller supplies both current authorized
  // intents; the renderer only accepts their exact canonical positions.
  const day = input.choices.find(choice =>
    choice.optionNo === 1 && choice.intent === "PREPARE_DAY");
  const night = input.choices.find(choice =>
    choice.optionNo === 2 && choice.intent === "PREPARE_NIGHT");
  if (input.choices.length !== 2 || day === undefined || night === undefined) {
    return err(appError("FLOW_BLOCKED", "Current period options are not available"));
  }
  const periodMenu = safeMenu(input.choices, new Set(["PREPARE_DAY", "PREPARE_NIGHT"]));
  if (!periodMenu.ok) return periodMenu;
  const visible = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*",
    "> _Bip-bip! Uma nova aventura espera por você!_",
    "",
    "Explore áreas acessíveis, encontre Pokémon",
    "selvagens, reúna recursos e descubra",
    "o que a região tem a oferecer.",
    "",
    "◇ *𝗦𝗨𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
    "",
    "*⌖ Local:* " + location,
    "*🎟️ Disponíveis:* " + String(input.remainingThisWeek) + "/" +
      String(EXPEDITION_WEEKLY_LIMIT),
    "*⌛ Duração:* 12 horas internas",
    "",
    "> O tempo avança conforme suas ações. A primeira ação efetiva utiliza uma cota de exploração.",
    "",
    "◇ *𝗘𝗦𝗖𝗢𝗟𝗛𝗔 𝗢 𝗣𝗘𝗥Í𝗢𝗗𝗢*",
    "",
    "1. ☀️ *Diurno* · `06:00–18:00`",
    "2. 🌙 *Noturno* · `18:00–06:00`",
    "",
    "> _O período influencia os encontros._",
    "> _`/equipe` ● `/inventario` ● `/explorar ajuda`_",
  ].join("\n");
  // The opening must remain fully expanded, exactly as approved in UX V4.
  return ok({ visible, expanded: "", text: visible, padded: false });
}

export function renderExpeditionV4PreparingPanel(
  input: ExpeditionV4PreparingInput,
): Result<ExpeditionV4PresentedPanel> {
  const expedition = input.expedition;
  const location = safeLocation(input.locationName);
  if (
    expedition.phase !== "PREPARING" ||
    expedition.elapsedMinutes !== 0 ||
    expedition.consumedWeekKey !== null ||
    expedition.endReason !== null ||
    expedition.revision < 0n ||
    !["DAY", "NIGHT"].includes(expedition.period) ||
    location === null ||
    !Number.isSafeInteger(input.remainingThisWeek) ||
    input.remainingThisWeek < 1 ||
    input.remainingThisWeek > EXPEDITION_WEEKLY_LIMIT
  ) {
    return err(appError("FLOW_BLOCKED", "No canonical PREPARING expedition view"));
  }
  const menu = safeMenu(input.choices, PREPARING_INTENTS);
  if (!menu.ok) return menu;
  const clock = expeditionClock(expedition.period as ExpeditionPeriod, 0);
  const periodLabel = expedition.period === "DAY" ? "diurna" : "noturna";
  const visible = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
    "> _Exploração " + periodLabel + " preparada!_",
    "",
    (expedition.period === "DAY" ? "☀️" : "🌙") +
      " `" + clock.currentTime + " → " + clock.endTime + "`",
    "⌖ *" + location + "*",
    "*⌛ 12h* disponíveis",
    "*🎟️ Cota ainda não consumida*",
  ].join("\n");
  const expanded = [
    "◇ *𝗔ÇÕ𝗘𝗦*",
    "",
    ...menu.value,
    "",
    "> _A primeira ação com custo inicia a aventura_",
  ].join("\n");
  const rendered = renderWhatsAppNativeReadMore({
    visible, expanded, combiningCount: input.combiningCount,
    ...(input.maxCodeUnits === undefined ? {} : { maxCodeUnits: input.maxCodeUnits }),
  });
  return ok({ visible, expanded, text: rendered.text, padded: rendered.padded });
}
