import type { VerifiedExpeditionSearchEncounterPreview } from "../../platform/exploration/postgres-expedition-search-encounter-preview.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { EXPEDITION_DURATION_MINUTES } from "./expedition-clock.js";

/** TRAIL continuation is a single 15-minute canonical encounter, not a
 * second 30-minute search, a new loot roll or a Pokémon chosen by the user.
 * Actual battle/capture options are delivered only after the sent proof. */
export function renderExpeditionV4TrailFollowPanel(input: {
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview;
  readonly elapsedMinutes: number;
  readonly consumedWeeklySlot: boolean;
}): Result<string> {
  const { speciesName, level, shiny } = input.encounterPreview;
  if (
    typeof speciesName !== "string" ||
    speciesName.trim() !== speciesName ||
    speciesName.length < 1 ||
    speciesName.length > 70 ||
    /[\r\n*_~`<>\u031d]/u.test(speciesName) ||
    speciesName.includes("[Ler mais]") ||
    /\p{Cc}/u.test(speciesName) ||
    !Number.isSafeInteger(level) ||
    level < 1 ||
    level > 100 ||
    typeof shiny !== "boolean" ||
    !Number.isSafeInteger(input.elapsedMinutes) ||
    input.elapsedMinutes < 45 ||
    input.elapsedMinutes > EXPEDITION_DURATION_MINUTES ||
    input.consumedWeeklySlot
  ) {
    return err(appError("FLOW_BLOCKED", "Followed trail has inconsistent canonical evidence"));
  }
  return ok(
    [
      "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗥𝗔𝗦𝗧𝗥𝗢𝗦*",
      "> _Você seguiu os rastros até um Pokémon selvagem!_",
      "",
      `◇ *${speciesName}* ● \`Nv. ${level}\``,
      ...(shiny ? ["✨ *Shiny confirmado pelo encontro*"] : []),
      "",
      "⌛ *Seguir rastros: `15 min`*",
      `⌛ *Restam ${EXPEDITION_DURATION_MINUTES - input.elapsedMinutes}min*`,
      "🎟️ *Nenhuma nova cota semanal utilizada*",
      "",
      "› _Encontro canônico registrado. Ações dependem de confirmação de envio e autorização atual._",
    ].join("\n"),
  );
}
