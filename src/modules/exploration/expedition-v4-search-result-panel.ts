import type { SearchOutcomeKind } from "../../platform/exploration/expedition-search-outcome-effect.js";
import type { VerifiedExpeditionSearchEncounterPreview } from "../../platform/exploration/postgres-expedition-search-encounter-preview.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { EXPEDITION_DURATION_MINUTES } from "./expedition-clock.js";

/**
 * A deliberately unfolded, private-only staging result card. Native WhatsApp
 * "Ler mais" is not assumed to work on every client until human UAT. This
 * presentation never grants capture, battle, item, XP or travel actions.
 */
export function renderExpeditionV4SearchResultPanel(input: {
  readonly kind: SearchOutcomeKind;
  readonly encounterPreview: VerifiedExpeditionSearchEncounterPreview | null;
  readonly elapsedMinutes: number;
  readonly consumedWeeklySlot: boolean;
  readonly canFollowTrail?: boolean;
  readonly historical?: boolean;
  readonly targetSpeciesSlug?: string;
}): Result<string> {
  if (
    input.targetSpeciesSlug !== undefined &&
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.targetSpeciesSlug)
  ) {
    return err(appError("FLOW_BLOCKED", "Invalid search target presentation"));
  }
  const isEncounter = input.kind === "DIRECT" || input.kind === "INCIDENTAL";
  if (
    !["NO_SIGNAL", "TRAIL", "INCIDENTAL", "DIRECT"].includes(input.kind) ||
    !Number.isSafeInteger(input.elapsedMinutes) ||
    input.elapsedMinutes < 30 ||
    input.elapsedMinutes > EXPEDITION_DURATION_MINUTES ||
    isEncounter !== (input.encounterPreview !== null)
  ) {
    return err(appError("FLOW_BLOCKED", "Search outcome cannot be presented safely"));
  }
  if (input.encounterPreview !== null) {
    const { speciesName, level, shiny } = input.encounterPreview;
    if (
      speciesName.length < 1 ||
      speciesName.length > 70 ||
      speciesName.trim() !== speciesName ||
      /(?:[\r\n*_~`<>]|\u031d)/u.test(speciesName) ||
      /\p{Cc}/u.test(speciesName) ||
      speciesName.includes("[Ler mais]") ||
      !Number.isSafeInteger(level) ||
      level < 1 ||
      level > 100 ||
      typeof shiny !== "boolean"
    ) {
      return err(appError("FLOW_BLOCKED", "Encounter details are not verified"));
    }
  }

  const lines = ["✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗕𝗨𝗦𝗖𝗔*"];
  switch (input.kind) {
    case "NO_SIGNAL":
      lines.push("> _Nenhum sinal de Pokémon foi registrado._");
      break;
    case "TRAIL":
      lines.push("> _Um rastro foi registrado na busca._");
      lines.push(
        input.canFollowTrail === true
          ? "› _Seguir os rastros: /explorar seguir ● `15 min`. Encontro sujeito ao catálogo publicado._"
          : "› _Seguir rastros permanece indisponível nesta prévia._",
      );
      break;
    case "INCIDENTAL":
    case "DIRECT": {
      const encounter = input.encounterPreview!;
      lines.push(
        input.kind === "INCIDENTAL"
          ? "> _Bip! Um Pokémon inesperado cruzou seu caminho!_"
          : "> _Um encontro selvagem foi confirmado pela busca._",
        "",
        `◇ *${encounter.speciesName}* ● \`Nv. ${encounter.level}\``,
      );
      if (encounter.shiny) lines.push("✨ *Shiny confirmado pelo encontro*");
      lines.push(
        "",
        input.historical
          ? "› _Busca anterior confirmada. Esse encontro não está disponível._"
          : "› _Encontro registrado. Batalha e captura continuam desativadas nesta prévia._",
      );
      break;
    }
  }
  if (input.targetSpeciesSlug !== undefined && !isEncounter && input.elapsedMinutes <= 690) {
    lines.push(
      "",
      "› _Continuar: /explorar buscar " + input.targetSpeciesSlug + "_",
      "› _Trocar alvo: /explorar buscar <espécie conhecida> · Parar: /explorar retomar._",
    );
  }
  lines.push(
    "",
    "⌛ *30min consumidos na expedição*",
    `⌛ *${input.historical ? "Restavam na busca" : "Restam"} ${EXPEDITION_DURATION_MINUTES - input.elapsedMinutes}min*`,
    input.consumedWeeklySlot
      ? "🎟️ *Primeira cota semanal utilizada*"
      : "🎟️ *Nenhuma cota adicional utilizada*",
    "",
    "> _Resultado real salvo no staging. Nenhuma recompensa inventada._",
    "› _Use /explorar status para consultar sua expedição._",
  );
  return ok(lines.join("\n"));
}
