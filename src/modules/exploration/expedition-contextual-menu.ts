import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export type ExpeditionMenuIntent =
  | "STATUS"
  | "TEAM"
  | "BAG"
  | "DESTINATIONS"
  | "TRAVEL"
  | "SEARCH_FREE"
  | "SEARCH_TARGET"
  | "FOLLOW_TRAIL"
  | "IGNORE_ENCOUNTER"
  | "BATTLE"
  | "CAPTURE"
  | "END";

export interface ExpeditionMenuChoice {
  /** Single-use, server-presented menu number; no opaque revision or UUID. */
  readonly optionNo: number;
  readonly intent: ExpeditionMenuIntent;
  readonly label: string;
  /** Unambiguous natural-language aliases for this option, derived server-side. */
  readonly phrases: readonly string[];
}

export interface ExpeditionMenuSelection {
  readonly intent: ExpeditionMenuIntent;
  readonly optionNo: number;
  /** The parser never authorizes or performs a mutation. */
  readonly requiresServerActionAuthorization: boolean;
}

const READ_ONLY = new Set<ExpeditionMenuIntent>(["STATUS", "TEAM", "BAG", "DESTINATIONS"]);
const MAX_OPTION_NO = 20;

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("pt-BR");
}

function allowedAlias(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    !/[\r\n*/~\x00-\x1f<>]/u.test(value) &&
    !value.startsWith("/")
  );
}

/**
 * Context-local human input parser for future V1.7 menus.
 *
 * Only the *current* server-provided options can be selected. No fuzzy match
 * guesses, chained commands, free-form species names, dynamic item IDs or
 * implicit yes/no decisions are accepted. In particular, typing "pokebola"
 * cannot consume a Ball unless it was the sole matching explicit choice.
 *
 * This is a pure interpreter, not a route, action dispatch or idempotency key.
 */
export function selectExpeditionMenuChoice(input: {
  readonly text: string | null;
  readonly choices: readonly ExpeditionMenuChoice[];
}): Result<ExpeditionMenuSelection> {
  const raw = input.text ?? "";
  const normalized = normalizeText(raw);
  if (
    normalized.length === 0 ||
    normalized.length > 80 ||
    normalized.includes("\n") ||
    raw.includes("\r") ||
    raw.includes("\n")
  ) {
    return err(
      appError("VALIDATION_FAILED", "Choose exactly one current expedition menu option", {
        userMessage: "Escolha apenas uma opção do menu atual da RotomDex.",
      }),
    );
  }

  const seenNumbers = new Set<number>();
  const matching = new Map<number, ExpeditionMenuChoice>();
  for (const choice of input.choices) {
    if (
      !Number.isSafeInteger(choice.optionNo) ||
      choice.optionNo < 1 ||
      choice.optionNo > MAX_OPTION_NO ||
      seenNumbers.has(choice.optionNo) ||
      choice.label.trim().length === 0 ||
      choice.label.length > 80
    ) {
      return err(appError("VALIDATION_FAILED", "Invalid expedition menu definition"));
    }
    seenNumbers.add(choice.optionNo);
    const aliases = [String(choice.optionNo), ...choice.phrases.map(normalizeText)];
    if (choice.phrases.some((phrase) => !allowedAlias(phrase))) {
      return err(appError("VALIDATION_FAILED", "Invalid expedition menu alias"));
    }
    if (aliases.includes(normalized)) matching.set(choice.optionNo, choice);
  }
  if (matching.size !== 1) {
    return err(
      appError("VALIDATION_FAILED", "Expedition input is not a unique current menu selection", {
        userMessage:
          matching.size > 1
            ? "Não consegui identificar uma única opção. Responda com o número do menu."
            : "Essa opção não está disponível agora. Consulte o menu atual da RotomDex.",
      }),
    );
  }

  const choice = [...matching.values()][0];
  if (choice === undefined) {
    return err(appError("VALIDATION_FAILED", "Expedition choice is missing"));
  }
  return ok({
    intent: choice.intent,
    optionNo: choice.optionNo,
    requiresServerActionAuthorization: !READ_ONLY.has(choice.intent),
  });
}

/** Only render safe, human-readable labels; no URL, ID or markup injection. */
export function renderExpeditionMenuChoices(choices: readonly ExpeditionMenuChoice[]): string {
  const lines = choices
    .filter(
      (choice) =>
        Number.isSafeInteger(choice.optionNo) &&
        choice.optionNo > 0 &&
        choice.optionNo <= MAX_OPTION_NO,
    )
    .map((choice) => {
      const label = choice.label.replace(/[\r\n*_~\x00-\x1f<>]/gu, " ").trim().slice(0, 80);
      return `${choice.optionNo}. ${label}`;
    });
  return ["◇ *𝗘𝗦𝗖𝗢𝗟𝗛𝗔 𝗨𝗠𝗔 𝗢𝗣ÇÃ𝗢*", "", ...lines, "", "› _Responda apenas com o número da opção._"].join(
    "\n",
  );
}
