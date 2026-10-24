import type { ExplorationRotomPreview } from "./expedition-rotom-preview.js";

/** WhatsApp-safe plain labels from the published World catalog. */
function safeLabel(label: string): string {
  return label
    .replace(/[\r\n*_~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * A status message, NOT an interactive command menu. Deliberately does not
 * display numbered travel options, capture buttons or actions with a cost.
 */
export function renderExplorationRotomPreview(view: ExplorationRotomPreview): string {
  const state =
    view.phase === "ACTIVE"
      ? "Em andamento"
      : view.phase === "PREPARING"
        ? "Preparada (primeira ação não executada)"
        : "Nenhuma expedição em andamento";
  const message = [
    "📟 *ROTOM · EXPLORAÇÃO*",
    `📍 Local atual: ${safeLabel(view.locationName)}`,
    `🧭 Estado: ${state}`,
    `🎟️ Cotas da semana: ${view.usedThisWeek}/3 utilizadas (${view.remainingThisWeek} restantes)`,
  ];
  if (view.clock !== null) {
    message.push(
      `${view.clock.period === "DAY" ? "☀️" : "🌙"} Período: ${view.clock.period === "DAY" ? "Diurno" : "Noturno"}`,
      `🕒 Relógio interno: ${view.clock.currentTime} · ${view.clock.elapsedMinutes}/720 min`,
      `⌛ Tempo restante: ${view.clock.remainingMinutes} min (fim às ${view.clock.endTime})`,
    );
    if (view.originMatchesCurrent === false) {
      message.push("🗺️ Origem preservada no histórico; posição atual confirmada pelo World.");
    }
  } else {
    message.push("🕒 Relógio interno: ainda não iniciado");
  }
  if (view.destinations.length > 0) {
    message.push(`🗺️ Rotas conhecidas: ${view.destinations.map(safeLabel).join(", ")}`);
  } else {
    message.push("🗺️ Nenhuma rota elegível identificada nesta consulta.");
  }
  message.push(
    "ℹ️ Consulta gratuita. Esta prévia não inicia expedições nem consome minutos.",
    "🔒 Viagem e ações ainda não foram liberadas neste modo.",
  );
  return message.join("\n");
}
