import type { ExpeditionFactualEventPage } from "../../platform/exploration/postgres-expedition-v4-event-history-reader.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export function renderExpeditionV4EventHistoryPanel(
  history: ExpeditionFactualEventPage,
): Result<string> {
  if (
    !["DAY", "NIGHT"].includes(history.period) ||
    !["VOLUNTARY", "CLOCK", "BLACKOUT"].includes(history.endReason) ||
    !Number.isSafeInteger(history.elapsedMinutes) ||
    history.elapsedMinutes < 1 ||
    history.elapsedMinutes > 720 ||
    !Number.isSafeInteger(history.page) ||
    !Number.isSafeInteger(history.pages) ||
    history.page < 1 ||
    history.pages < 1 ||
    history.page > history.pages ||
    !Number.isSafeInteger(history.totalEvents) ||
    history.totalEvents < 1 ||
    history.events.length < 1 ||
    history.events.length > 12
  ) {
    return err(appError("FLOW_BLOCKED", "No safe saved expedition timeline"));
  }
  const lines = [
    "✦ *𝗥𝗢𝗧𝗢𝗠 · 𝗛𝗜𝗦𝗧Ó𝗥𝗜𝗖𝗢*",
    "> _Somente acontecimentos comprovados no banco._",
    "",
    "◇ *𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*",
    (history.period === "DAY" ? "☀️ Diurna" : "🌙 Noturna") +
      " · `" + history.elapsedMinutes + " min`",
    "◇ *Término:* " + (
      history.endReason === "VOLUNTARY" ? "Voluntário" :
      history.endReason === "CLOCK" ? "Tempo esgotado" : "Derrota total"
    ),
    "",
    "◇ *𝗘𝗩𝗘𝗡𝗧𝗢𝗦*",
  ];
  for (let i = 0; i < history.events.length; i++) {
    const event = history.events[i]!;
    if (
      event.description.length < 1 ||
      event.description.length > 100 ||
      /[\r\n*_~`<>\u031d]/u.test(event.description) ||
      event.description.includes("[Ler mais]") ||
      !Number.isSafeInteger(event.elapsedMinutes) && event.elapsedMinutes !== null ||
      event.elapsedMinutes !== null &&
        (event.elapsedMinutes < 0 || event.elapsedMinutes > 720)
    ) {
      return err(appError("FLOW_BLOCKED", "Unsafe stored event cannot be displayed"));
    }
    const number = (history.page - 1) * 12 + i + 1;
    lines.push(
      `${number}. ${event.description}` +
        (event.elapsedMinutes === null ? "" : ` · \`${event.elapsedMinutes}min\``),
    );
  }
  lines.push(
    "",
    `◇ *Página ${history.page}/${history.pages}* · ${history.totalEvents} eventos comprovados`,
    ...(history.page < history.pages
      ? [`› _Próxima: /explorar eventos ${history.page + 1}_`]
      : []),
    ...(history.page > 1 ? [`› _Anterior: /explorar eventos ${history.page - 1}_`] : []),
    "> _Vitórias, XP, moedas e premiações não são presumidos._",
    "› _Relatório narrativo e recompensa final exigem aprovação da equipe._",
  );
  return ok(lines.join("\n"));
}
