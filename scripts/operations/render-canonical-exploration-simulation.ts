import { writeFile } from "node:fs/promises";
import {
  advanceExpedition,
  type ExpeditionSnapshot,
  endExpedition,
} from "../../src/modules/exploration/expedition-state.js";
import { renderExpeditionV4ActivePanel } from "../../src/modules/exploration/expedition-v4-active-panel.js";
import {
  renderExpeditionV4OpeningPanel,
  renderExpeditionV4PreparingPanel,
} from "../../src/modules/exploration/expedition-v4-preparation-panel.js";
import { expeditionWeeklyAdmission } from "../../src/modules/exploration/expedition-week.js";
import type { Result } from "../../src/shared-kernel/result.js";

function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const lines = [
  "POKÉMON BEYOND — SIMULAÇÃO LITERAL DE COTA/PREPARAÇÃO — 04/11/2026",
  "Escopo: transições reais de domínio e renderers reais, com fixture sintética.",
  "Não é captura de WhatsApp nem prova de Inbox/Outbox; persistência/concorrência estão nos testes PG.",
  "Dobra desativada (combiningCount=0): todo o texto continua acessível. Nenhum marcador editorial é payload.",
  "Local usado na fixture não aprova catálogo, rotas, odds, loot ou fuso de produção.",
  "",
];
const emit = (command: string, text: string) =>
  lines.push("JOGADOR → " + command, "BOT →", text, "");
const opening = requireValue(
  renderExpeditionV4OpeningPanel({
    phase: "NONE",
    locationName: "Campos de Yun",
    remainingThisWeek: 6,
    canPrepareUnderPolicy: true,
    choices: [
      { optionNo: 1, intent: "PREPARE_DAY", label: "Diurno", phrases: [] },
      { optionNo: 2, intent: "PREPARE_NIGHT", label: "Noturno", phrases: [] },
    ],
  }),
);
emit("/explorar", opening.text);
const preparing: ExpeditionSnapshot = {
  expeditionId: "synthetic",
  playerId: "synthetic",
  areaId: "synthetic",
  period: "NIGHT",
  phase: "PREPARING",
  elapsedMinutes: 0,
  consumedWeekKey: null,
  endReason: null,
  revision: 0n,
};
const preparation = requireValue(
  renderExpeditionV4PreparingPanel({
    expedition: preparing,
    locationName: "Campos de Yun",
    remainingThisWeek: 6,
    combiningCount: 0,
    choices: [
      { optionNo: 1, intent: "SEARCH_FREE", label: "🔎 Buscar Pokémon ● 30 min", phrases: [] },
      { optionNo: 3, intent: "DESTINATIONS", label: "🗺️ Consultar destinos", phrases: [] },
    ],
  }),
);
emit("/explorar noite", preparation.text);
lines.push(
  "[EVIDÊNCIA DE DOMÍNIO: preparação ainda tem elapsedMinutes=0 e consumedWeekKey=null; seis cotas disponíveis.]",
  "",
);
const advanced = requireValue(
  advanceExpedition({
    expedition: preparing,
    expectedRevision: 0n,
    minutes: 30,
    weekKey: "2026-11-02",
    consumedThisWeek: 0,
  }),
);
const active = requireValue(
  renderExpeditionV4ActivePanel({
    phase: "ACTIVE",
    period: "NIGHT",
    currentTime: "18:30",
    elapsedMinutes: advanced.expedition.elapsedMinutes,
    combiningCount: 0,
    choices: [{ optionNo: 1, intent: "SEARCH_FREE", label: "🔎 Buscar Pokémon", phrases: [] }],
  }),
);
emit("/explorar buscar", active.text);
lines.push(
  "[EVIDÊNCIA DE DOMÍNIO: uma cota consumida e 30 minutos internos. O painel não afirma espécie, item, captura ou recompensa.]",
  "",
);
requireValue(
  endExpedition({ expedition: advanced.expedition, expectedRevision: 1n, reason: "VOLUNTARY" }),
);
lines.push(
  "[FIM DA EXPEDIÇÃO SINTÉTICA PELO DOMÍNIO: VOLUNTARY; nenhum prêmio concedido. Texto final do runtime não é simulado por este gerador.]",
  "",
);
for (const consumed of [3, 4, 5, 6]) {
  lines.push(
    "[CONSULTA SINTÉTICA: " +
      consumed +
      " consumos históricos → " +
      expeditionWeeklyAdmission(consumed, "NONE").remaining +
      " disponíveis.]",
    "",
  );
}
const denied = advanceExpedition({
  expedition: preparing,
  expectedRevision: 0n,
  minutes: 30,
  weekKey: "2026-11-02",
  consumedThisWeek: 6,
});
if (denied.ok) throw new Error("The seventh expedition must be denied");
emit("[sétima primeira ação, fixture isolada]", String(denied.error.details?.userMessage));
lines.push(
  "[FONTE: abertura original muda apenas 3/3 para 6/6. Preparação usa subconjunto autorizado das ações; nenhum serviço indisponível é anunciado.]",
  "",
);
const output = new URL("../../docs/ux/canonical/SIMULATION.txt", import.meta.url);
await writeFile(output, lines.join("\n"));
console.log(output.pathname);
