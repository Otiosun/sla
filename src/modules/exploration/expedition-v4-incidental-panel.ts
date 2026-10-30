import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { renderWhatsAppNativeReadMore } from "../messaging/whatsapp-native-read-more.js";

/**
 * V4 incidental encounter preview (SHADOW ONLY). An authorized caller must
 * supply a real ENGAGED encounter, its published species display,
 * current capture eligibility, inventory and live menu revision.
 *
 * No WhatsApp route, battle, capture, inventory debit or encounter mutation.
 */
export type IncidentalBallKind = "POKE" | "GREAT" | "ULTRA";
export type IncidentalAction =
  | { readonly optionNo: 1; readonly kind: "BATTLE" }
  | { readonly optionNo: 2 | 3 | 4; readonly kind: "CAPTURE"; readonly ball: IncidentalBallKind }
  | { readonly optionNo: 0; readonly kind: "IGNORE" };

export interface IncidentalBallAvailability {
  readonly kind: IncidentalBallKind;
  /** Stock confirmed by the canonical inventory; zero stock is never offered. */
  readonly quantity: number;
  /** The canonical Capture policy/handler must also permit this Ball now. */
  readonly captureAuthorized: boolean;
}

export interface IncidentalEncounterPanelInput {
  readonly source: "INCIDENTAL";
  readonly encounterStatus: "ENGAGED";
  readonly encounterId: string;
  readonly encounterRevision: bigint;
  readonly speciesName: string;
  readonly level: number;
  readonly canBattle: boolean;
  readonly balls: readonly IncidentalBallAvailability[];
  readonly canIgnore: boolean;
  /** Canonical V4 incidental-ignore cost; NOT a global flee cost. */
  readonly ignoreMinutes: 10;
  readonly combiningCount: number;
  readonly maxCodeUnits?: number;
}

export interface IncidentalEncounterPanel {
  readonly visible: string;
  readonly expanded: string;
  readonly text: string;
  readonly padded: boolean;
  readonly choices: readonly IncidentalAction[];
  readonly encounterRevision: bigint;
  readonly encounterId: string;
}

const BALL_OPTIONS: Readonly<Record<IncidentalBallKind, {
  readonly optionNo: 2 | 3 | 4;
  readonly text: string;
}>> = {
  POKE: { optionNo: 2, text: "◉ Poké Ball" },
  GREAT: { optionNo: 3, text: "◈ Great Ball" },
  ULTRA: { optionNo: 4, text: "✧ Ultra Ball" },
};

export function renderExpeditionV4IncidentalPanel(
  input: IncidentalEncounterPanelInput,
): Result<IncidentalEncounterPanel> {
  const species = input.speciesName.replace(/\s+/gu, " ").trim();
  if (
    input.source !== "INCIDENTAL" ||
    input.encounterStatus !== "ENGAGED" ||
    !/^[a-f0-9-]{36}$/iu.test(input.encounterId) ||
    input.encounterRevision < 0n ||
    species.length === 0 ||
    species.length > 70 ||
    !/^[\p{L}\p{N} .:'’!?♀♂-]+$/u.test(species) ||
    !Number.isSafeInteger(input.level) ||
    input.level < 1 || input.level > 100 ||
    input.ignoreMinutes !== 10 ||
    input.balls.length > 3
  ) {
    return err(appError("VALIDATION_FAILED", "Incidental encounter does not have a safe current view"));
  }
  const seenBalls = new Set<IncidentalBallKind>();
  const options: IncidentalAction[] = [];
  const actions: string[] = [];
  if (input.canBattle) {
    options.push({ optionNo: 1, kind: "BATTLE" });
    actions.push("1. ⚔️ Batalhar");
  }
  const captureLines: string[] = [];
  // Preserve the canonical 2/3/4 hierarchy even if inventory rows arrive unsorted.
  const sortedBalls = [...input.balls].sort(
    (a, b) => (BALL_OPTIONS[a.kind]?.optionNo ?? 99) - (BALL_OPTIONS[b.kind]?.optionNo ?? 99),
  );
  for (const ball of sortedBalls) {
    if (seenBalls.has(ball.kind) || !(ball.kind in BALL_OPTIONS) ||
      !Number.isSafeInteger(ball.quantity) || ball.quantity < 0 || ball.quantity > 9999) {
      return err(appError("VALIDATION_FAILED", "Invalid current Ball availability"));
    }
    seenBalls.add(ball.kind);
    if (ball.quantity === 0 || !ball.captureAuthorized) continue;
    const option = BALL_OPTIONS[ball.kind];
    options.push({ optionNo: option.optionNo, kind: "CAPTURE", ball: ball.kind });
    captureLines.push(String(option.optionNo) + ". " + option.text +
      " ● `×" + String(ball.quantity) + "`");
  }
  if (input.canIgnore) options.push({ optionNo: 0, kind: "IGNORE" });
  if (options.length === 0) {
    return err(appError("FLOW_BLOCKED", "No authorized incidental encounter actions"));
  }
  const visible = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗡𝗖𝗢𝗡𝗧𝗥𝗢*",
    "> _Bip! Um Pokémon inesperado cruzou seu caminho!_",
    "",
    "◇ *" + species + "* ● `Nv. " + String(input.level) + "`",
  ].join("\n");
  const expanded = [
    "> _Você procurava outra espécie, mas encontrou um Pokémon pelo caminho..._",
    ...(actions.length > 0 ? ["", "◇ *𝗔ÇÕ𝗘𝗦*", "", ...actions] : []),
    ...(captureLines.length > 0 ? ["", "◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔𝗥*", "", ...captureLines] : []),
    ...(input.canIgnore ? ["", "0. ↩️ Ignorar ● `10 min`"] : []),
  ].join("\n");
  const rendered = renderWhatsAppNativeReadMore({
    visible, expanded, combiningCount: input.combiningCount,
    ...(input.maxCodeUnits === undefined ? {} : { maxCodeUnits: input.maxCodeUnits }),
  });
  return ok({
    visible, expanded, text: rendered.text, padded: rendered.padded,
    choices: options, encounterRevision: input.encounterRevision,
    encounterId: input.encounterId,
  });
}

/**
 * Input interpreter, not a capability: handlers MUST still verify current
 * encounter id/revision, player authorization, Capture policy and inventory
 * immediately before doing a battle/capture/10-min ignore mutation.
 */
export function selectCurrentIncidentalAction(input: {
  readonly raw: string | null;
  readonly menu: IncidentalEncounterPanel;
  readonly expectedEncounterRevision: bigint;
  readonly expectedEncounterId: string;
}): Result<IncidentalAction> {
  if (input.expectedEncounterId !== input.menu.encounterId ||
      input.expectedEncounterRevision !== input.menu.encounterRevision) {
    return err(appError("REVISION_CONFLICT", "Incidental encounter menu became stale"));
  }
  const raw = input.raw ?? "";
  if (!/^(?:0|[1-4])$/u.test(raw)) {
    return err(appError("VALIDATION_FAILED", "Choose one current incidental menu number"));
  }
  const choice = input.menu.choices.find(item => String(item.optionNo) === raw);
  return choice === undefined
    ? err(appError("FLOW_BLOCKED", "That action is not in the current authorized menu"))
    : ok(choice);
}
