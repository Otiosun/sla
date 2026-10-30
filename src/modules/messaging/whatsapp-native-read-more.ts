/**
 * Presentation-only fallback-safe builder for WhatsApp's native "Ler mais".
 *
 * This is an opt-in experiment. WhatsApp (not Baileys/the bot) decides whether
 * a long message folds. Never emit the literal editorial marker "[Ler mais]".
 * The only padding character is U+031D, requested in the approved UX reference.
 * The amount must come from a device-tested configuration; there is purposely
 * no assumed global default. DO NOT connect this helper to live routes before
 * Android, iOS, Web and caption acceptance tests.
 */
export const WHATSAPP_READ_MORE_COMBINING_CHARACTER = "\u031d" as const;

export interface WhatsAppReadMoreInput {
  readonly visible: string;
  readonly expanded: string;
  /** Calibrated number of U+031D combining characters. Must be explicit. */
  readonly combiningCount: number;
  /** Optional provider-specific limit in UTF-16 code units (e.g. for captions). */
  readonly maxCodeUnits?: number;
}

export interface WhatsAppReadMoreResult {
  readonly text: string;
  readonly padded: boolean;
  readonly reason: "APPLIED" | "INVALID_CONTENT" | "UNCALIBRATED" | "OVER_LIMIT";
}

/**
 * Fails open visually and closed mechanically: even when folding cannot be
 * applied, the complete visible and expanded content is still present.
 * No options are removed or re-numbered, and no gameplay state changes here.
 */
export function renderWhatsAppNativeReadMore(input: WhatsAppReadMoreInput): WhatsAppReadMoreResult {
  // The design marker is not part of the player-facing payload.
  const visible = input.visible.replaceAll("[Ler mais]", "").trimEnd();
  const expanded = input.expanded.replaceAll("[Ler mais]", "").trimStart();
  const fallback = [visible, expanded].join("\n\n");
  if (
    visible.trim().length === 0 ||
    expanded.trim().length === 0 ||
    input.visible.includes("[Ler mais]") ||
    input.expanded.includes("[Ler mais]")
  ) {
    return { text: fallback, padded: false, reason: "INVALID_CONTENT" };
  }
  if (!Number.isSafeInteger(input.combiningCount) || input.combiningCount <= 0 ||
    input.combiningCount > 16384) {
    return { text: fallback, padded: false, reason: "UNCALIBRATED" };
  }
  const separator = WHATSAPP_READ_MORE_COMBINING_CHARACTER.repeat(input.combiningCount);
  const folded = [visible, separator, expanded].join("\n\n");
  if (
    input.maxCodeUnits !== undefined &&
    (!Number.isSafeInteger(input.maxCodeUnits) ||
      input.maxCodeUnits <= 0 ||
      folded.length > input.maxCodeUnits)
  ) {
    return { text: fallback, padded: false, reason: "OVER_LIMIT" };
  }
  return { text: folded, padded: true, reason: "APPLIED" };
}
