import type { ExplorationRotomPreview } from "./expedition-rotom-preview.js";

/** Keep published World names from injecting WhatsApp markup or fake commands. */
function safeLabel(label: string): string {
  return label
    .replace(/[\r\n*_~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function remainingTimeLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const leftover = minutes % 60;
  if (hours === 0) return `${leftover}min`;
  return leftover === 0 ? `${hours}h` : `${hours}h${String(leftover).padStart(2, "0")}`;
}

/**
 * Use the existing Bell/Rotom WhatsApp language: Unicode-bold headlines,
 * indented subtitles, short narrative blockquotes, ◇ sections and › footers.
 * This is a private status panel, NEVER a numbered menu or action prompt.
 * The protected Rotom photo/arrival assets are deliberately not repeated.
 */
export function renderExplorationRotomPreview(view: ExplorationRotomPreview): string {
  const state =
    view.phase === "ACTIVE"
      ? "Em andamento"
      : view.phase === "PREPARING"
        ? "Preparada (primeira ação não executada)"
        : "Nenhuma expedição em andamento";
  const introduction =
    view.phase === "ACTIVE"
      ? "Bip-bip! Encontrei sua expedição em andamento, treinador."
      : view.phase === "PREPARING"
        ? "Bip-bip! Seus preparativos estão guardados. O relógio continua parado."
        : "Bip-bip! Ainda não encontrei uma expedição preparada por aqui.";

  const message = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗘𝗫𝗣𝗟𝗢𝗥𝗔ÇÃ𝗢*",
    "　RotomDex · Registro de jornada",
    "",
    `> _${introduction}_`,
    "",
    "◇ *𝗟𝗢𝗖𝗔𝗟𝗜𝗭𝗔ÇÃ𝗢*",
    "",
    `⌖ *Local atual:* ${safeLabel(view.locationName)}`,
  ];
  if (view.originMatchesCurrent === false) {
    message.push("　↳ _Origem preservada no histórico; localização atual confirmada._");
  }

  message.push(
    "",
    "◇ *𝗘𝗦𝗧𝗔𝗗𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
    "",
    `◈ *Estado:* ${state}`,
  );

  if (view.clock !== null) {
    message.push(
      `${view.clock.period === "DAY" ? "☀️" : "🌙"} *Período:* ${view.clock.period === "DAY" ? "Diurno" : "Noturno"}`,
      `🕒 *Relógio interno:* \`${view.clock.currentTime}\` · \`${view.clock.elapsedMinutes}/720 min\``,
      `⌛ *Tempo restante:* ${remainingTimeLabel(view.clock.remainingMinutes)} (\`${view.clock.remainingMinutes} min\`) · fim às \`${view.clock.endTime}\``,
    );
  } else {
    message.push("🕒 *Relógio interno:* ainda não iniciado");
  }

  message.push(
    "",
    "◇ *𝗖𝗢𝗧𝗔𝗦 𝗗𝗔 𝗦𝗘𝗠𝗔𝗡𝗔*",
    "",
    `🎟️ \`${view.usedThisWeek}/3\` utilizadas (${view.remainingThisWeek} restantes)`,
    "",
    "◇ *𝗥𝗢𝗧𝗔𝗦 𝗖𝗢𝗡𝗛𝗘𝗖𝗜𝗗𝗔𝗦*",
    "",
  );
  if (view.destinations.length > 0) {
    message.push(...view.destinations.map((destination) => `• ${safeLabel(destination)}`));
  } else {
    message.push("　Nenhuma rota elegível identificada nesta consulta.");
  }

  message.push(
    "",
    "┄┄ ◇ *𝗔𝗩𝗜𝗦𝗢 𝗗𝗢 𝗥𝗢𝗧𝗢𝗠* ┄┄",
    "",
    "› _Consulta gratuita. Esta prévia não inicia expedições nem consome minutos._",
    "› _Viagem e ações ainda não foram liberadas neste modo._",
  );
  return message.join("\n");
}
