import type { PurchaseResult, SaleResult } from "../economy/contracts.js";
import type { WorldServiceKind } from "./contracts.js";
import type { MartCatalogCategory, MartCatalogItem } from "./mart-catalog.js";
import { MART_CATALOG } from "./mart-catalog.js";
import type { MartSellableInventoryItem } from "./mart-sale.js";
import type { PokemonPcStorageSnapshot } from "./pc-storage-service.js";

const CATEGORY_LABELS: Readonly<Record<MartCatalogCategory, string>> = {
  CAPTURE: "┄┄ ◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔* ┄┄",
  RECOVERY: "┄┄ ＋ *𝗥𝗘𝗖𝗨𝗣𝗘𝗥𝗔ÇÃ𝗢* ┄┄",
  TREATMENT: "┄┄ ✚ *𝗧𝗥𝗔𝗧𝗔𝗠𝗘𝗡𝗧𝗢* ┄┄",
  FIELD: "┄┄ ⌁ *𝗖𝗔𝗠𝗣𝗢* ┄┄",
  BATTLE: "┄┄ ◆ *𝗕𝗔𝗧𝗔𝗟𝗛𝗔* ┄┄",
};

function formatMoney(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatQuantity(value: bigint): string {
  return value.toString().padStart(2, "0");
}

function formatPcNumber(value: number): string {
  return value.toString().padStart(2, "0");
}

function styledUpper(value: string): string {
  return [...value.toUpperCase()]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code === undefined || code < 65 || code > 90) return character;
      return String.fromCodePoint(0x1d5d4 + code - 65);
    })
    .join("");
}

export function renderWorldServiceEntry(kind: WorldServiceKind): string {
  switch (kind) {
    case "POKEMART":
      return [
        "ᯓ *𝗖𝗢𝗠𝗘𝗥𝗖𝗜𝗔𝗡𝗧𝗘*",
        "　POKÉ MART · Balcão",
        "",
        "> _Atrás do balcão, um homem de meia-idade organiza algumas mercadorias. Ao perceber sua presença, ele ergue os olhos e sorri._",
        "",
        "🧑‍🌾 _— Olá, treinador! Seja bem-vindo ao Poké Mart da Vila dos Arrozais. Vai precisar de alguns suprimentos para a estrada?_",
        "",
        "╭─ ◈ *𝗔𝗧𝗘𝗡𝗗𝗜𝗠𝗘𝗡𝗧𝗢*",
        "│",
        "│ 🛒　`/comprar`",
        "│ ₽　　`/vender`",
        "│ ◇　　`/itens`",
        "│",
        "╰─ ‹　`/sair`",
      ].join("\n");
    case "POKEMON_CENTER":
      return [
        "　　　　　　♡　＋　♡",
        "",
        "　　　*𝗖𝗘𝗡𝗧𝗥𝗢 𝗣𝗢𝗞É𝗠𝗢𝗡*",
        "　　　　Vila dos Arrozais",
        "",
        "━━━━━━━━━━━━━━━━━━",
        "",
        "> _Ao atravessar a porta, um pequeno sino anuncia sua chegada._",
        "",
        "_O ambiente é fresco e tranquilo. O som suave das máquinas se mistura às conversas dos treinadores e aos chamados ocasionais de alguns Pokémon._",
        "",
        "　　　　　♡ *𝗥𝗘𝗖𝗘𝗣ÇÃ𝗢*",
        "",
        "ᯓ *𝗘𝗡𝗙𝗘𝗥𝗠𝗘𝗜𝗥𝗔 𝗛𝗔𝗡𝗔*",
        "",
        "👩‍⚕️ _— Olá! Bem-vindo ao Centro Pokémon. Espero que sua jornada esteja sendo tranquila. Posso ajudá-lo com alguma coisa?_",
        "",
        "♡　`/curar`",
        "▣　`/pc`",
        "ᯓ　`/conversar`",
        "‹　`/sair`",
        "",
        "　　　　　　♡",
      ].join("\n");
    case "PC":
      return [
        "▣ *𝗣𝗖 𝗣𝗢𝗞É𝗠𝗢𝗡*",
        "　Sistema de Armazenamento",
        "",
        "　　　　〔 `CONECTADO` 〕",
        "",
        "▣　`/caixas`",
        "↓　`/depositar`",
        "↑　`/retirar`",
        "↻　`/organizar`",
        "‹　`/sair`",
      ].join("\n");
  }
}

export function renderPokemonPcStorage(snapshot: PokemonPcStorageSnapshot): string {
  const occupiedByBox = new Map(snapshot.boxes.map((box) => [box.boxNo, box.occupied]));
  const highestBox = snapshot.boxes.reduce((highest, box) => Math.max(highest, box.boxNo), 0);
  const visibleBoxes = Math.min(Math.max(highestBox, 4), 4);
  const lines = [
    "▣ *𝗣𝗖 𝗣𝗢𝗞É𝗠𝗢𝗡*",
    "　Sistema de Armazenamento",
    "",
    "　　　　〔 `CONECTADO` 〕",
    "",
    "> _A tela se ilumina e apresenta os dados da sua equipe e dos Pokémon armazenados._",
    "",
    "◇ *𝗘𝗤𝗨𝗜𝗣𝗘*",
    `╰─ \`${formatPcNumber(snapshot.team.length)} / 06\``,
    "",
    "▣ *𝗖𝗔𝗜𝗫𝗔𝗦*",
    "",
  ];

  for (let boxNo = 1; boxNo <= visibleBoxes; boxNo += 1) {
    lines.push(
      `　Caixa ${formatPcNumber(boxNo)}　\`${formatPcNumber(occupiedByBox.get(boxNo) ?? 0)} / 30\``,
    );
  }
  if (highestBox > visibleBoxes) lines.push("　…");

  lines.push(
    "",
    "──────────────",
    "",
    "▣　`/caixas`",
    "↓　`/depositar`",
    "↑　`/retirar`",
    "↻　`/organizar`",
    "‹　`/sair`",
  );
  return lines.join("\n");
}

export function renderPokemonPcBoxes(snapshot: PokemonPcStorageSnapshot): string {
  const boxes = [...snapshot.boxes].sort((left, right) => left.boxNo - right.boxNo);
  const lines = ["▣ *𝗖𝗔𝗜𝗫𝗔𝗦*", "　PC Pokémon · Armazenamento", ""];

  if (boxes.length === 0) {
    lines.push("　Caixa 01　`00 / 30`", "", "_Nenhum Pokémon armazenado._");
  } else {
    for (const box of boxes) {
      lines.push(
        `▣ *Caixa ${formatPcNumber(box.boxNo)}*　\`${formatPcNumber(box.occupied)} / 30\``,
      );
      for (const pokemon of box.pokemon) {
        lines.push(
          `　\`${formatPcNumber(pokemon.slotNo)}\` ${pokemon.displayName} · Nv. ${formatPcNumber(pokemon.level)}`,
        );
      }
      lines.push("");
    }
    if (lines.at(-1) === "") lines.pop();
  }

  lines.push("", "‹　`/pc`");
  return lines.join("\n");
}

export function renderMartCatalog(): string {
  const lines = [
    "🛒 *𝗣𝗥𝗔𝗧𝗘𝗟𝗘𝗜𝗥𝗔𝗦*",
    "　Poké Mart · Catálogo",
    "",
    "> _O comerciante se afasta do balcão e aponta para as prateleiras cuidadosamente organizadas._",
    "",
    "🧑‍🌾 _— Pode escolher. Temos tudo que um treinador precisa para dar os primeiros passos pela região._",
    "",
  ];

  let category: MartCatalogCategory | null = null;
  for (const item of MART_CATALOG) {
    if (item.category !== category) {
      if (category !== null) lines.push("");
      category = item.category;
      lines.push(CATEGORY_LABELS[category]);
    }
    lines.push(`\`${item.code}\` ${item.displayName} · *₽${formatMoney(item.unitPrice)}*`);
  }

  lines.push("", "› _Responda com o número da mercadoria._");
  return lines.join("\n");
}

export function renderMartItemSelection(item: MartCatalogItem): string {
  return [
    `◇ *${styledUpper(item.displayName)}*`,
    "　Consumível · Poké Mart",
    "",
    "> _O comerciante retira algumas unidades da prateleira e as coloca cuidadosamente sobre o balcão._",
    "",
    "╭─ *𝗘𝗧𝗜𝗤𝗨𝗘𝗧𝗔*",
    "│",
    `│ Unidade　　　*₽${formatMoney(item.unitPrice)}*`,
    "│",
    "",
    "🧑‍🌾 _— Quantas unidades deseja levar?_",
    "",
    "╭─ ◇ *𝗣𝗘𝗗𝗜𝗗𝗢*",
    `╰─ \`${item.displayName} / 5\``,
  ].join("\n");
}

export function renderMartPurchaseSuccess(item: MartCatalogItem, result: PurchaseResult): string {
  const before = result.inventoryQuantity - result.itemQuantity;
  return [
    "　　　　　✦ *𝗖𝗢𝗠𝗣𝗥𝗔 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔*",
    "",
    `　　　　　　　*＋ ${formatQuantity(result.itemQuantity)}x*`,
    `　　　　　　*${styledUpper(item.displayName)}*`,
    "",
    "> _O comerciante guarda os itens em uma pequena sacola e a coloca sobre o balcão._",
    "",
    "╭─ 🧾 *𝗥𝗘𝗖𝗜𝗕𝗢*",
    "│",
    `│ Total　　　 *₽${formatMoney(result.priceAmount)}*`,
    `│ Saldo　　　 *₽${formatMoney(result.walletAmount)}*`,
    `│ Mochila　　 *${formatQuantity(before)} → ${formatQuantity(result.inventoryQuantity)}*`,
    "│",
    "╰─ ✦ *Pedido entregue*",
    "",
    "🧑‍🌾 _— Pronto! Cuide bem dos seus Pokémon._",
    "",
    "`/comprar` · `/vender` · `/itens` · `/sair`",
  ].join("\n");
}

export function renderMartInsufficientFunds(
  item: MartCatalogItem,
  quantity: bigint,
  walletAmount: bigint,
  requiredAmount: bigint,
): string {
  const missing = requiredAmount > walletAmount ? requiredAmount - walletAmount : 0n;
  return [
    "₽ *𝗗𝗜𝗡𝗛𝗘𝗜𝗥𝗢 𝗜𝗡𝗦𝗨𝗙𝗜𝗖𝗜𝗘𝗡𝗧𝗘*",
    "━━━━━━━━━━━━━━━━━━",
    "",
    "◇ *Pedido*",
    `　${quantity.toString()}x ${item.displayName}`,
    "",
    `₽ Seu saldo　　 *₽${formatMoney(walletAmount)}*`,
    `₽ Necessário　　*₽${formatMoney(requiredAmount)}*`,
    `△ Faltam　　　 *₽${formatMoney(missing)}*`,
    "",
    "> _Você não possui dinheiro suficiente para realizar essa compra._",
    "",
    "🧑‍🌾 _— Talvez seja melhor dar uma olhada nas tarefas da vila antes de voltar..._",
  ].join("\n");
}

export function renderMartSaleList(items: readonly MartSellableInventoryItem[]): string {
  const lines = [
    "₽ *𝗩𝗘𝗡𝗗𝗘𝗥*",
    "　Poké Mart · Seu inventário",
    "",
    "> _O comerciante observa os itens que você separou sobre o balcão._",
    "",
    "🧑‍🌾 _— Posso comprar alguns desses itens. Veja o que estou aceitando hoje._",
    "",
  ];

  if (items.length === 0) {
    lines.push(
      "◇ *Nenhum item disponível para venda.*",
      "",
      "🧑‍🌾 _— Parece que você não tem nada que eu esteja comprando agora._",
    );
    return lines.join("\n");
  }

  lines.push("┄┄ ◇ *𝗜𝗧𝗘𝗡𝗦 𝗔𝗖𝗘𝗜𝗧𝗢𝗦* ┄┄");
  items.forEach((item, index) => {
    const code = String(index + 1).padStart(2, "0");
    lines.push(
      `\`${code}\` ${item.displayName} · x${formatQuantity(item.inventoryQuantity)} · *₽${formatMoney(item.unitSaleAmount)}*`,
    );
  });
  lines.push("", "› _Responda com o número do item._");
  return lines.join("\n");
}

export function renderMartSaleItemSelection(item: MartSellableInventoryItem): string {
  return [
    `₽ *${styledUpper(item.displayName)}*`,
    "　Poké Mart · Venda",
    "",
    "> _O comerciante examina o item por alguns instantes antes de indicar o valor de compra._",
    "",
    "╭─ ◇ *𝗔𝗩𝗔𝗟𝗜𝗔ÇÃ𝗢*",
    "│",
    `│ Unidade　　　*₽${formatMoney(item.unitSaleAmount)}*`,
    `│ Na mochila　 *x${formatQuantity(item.inventoryQuantity)}*`,
    "│",
    "",
    "🧑‍🌾 _— Quantas unidades quer vender?_",
    "",
    "╭─ ◇ *𝗣𝗘𝗗𝗜𝗗𝗢*",
    `╰─ \`${item.displayName} / 2\``,
  ].join("\n");
}

export function renderMartSaleSuccess(item: MartSellableInventoryItem, result: SaleResult): string {
  const before = result.inventoryQuantity + result.saleQuantity;
  return [
    "　　　　　✦ *𝗩𝗘𝗡𝗗𝗔 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔*",
    "",
    `　　　　　　　*− ${formatQuantity(result.saleQuantity)}x*`,
    `　　　　　　*${styledUpper(item.displayName)}*`,
    "",
    "> _O comerciante recolhe os itens, confere a quantidade e separa o pagamento._",
    "",
    "╭─ 🧾 *𝗥𝗘𝗖𝗜𝗕𝗢*",
    "│",
    `│ Recebido　　 *₽${formatMoney(result.saleAmount)}*`,
    `│ Saldo　　　 *₽${formatMoney(result.walletAmount)}*`,
    `│ Mochila　　 *${formatQuantity(before)} → ${formatQuantity(result.inventoryQuantity)}*`,
    "│",
    "╰─ ✦ *Venda registrada*",
    "",
    "🧑‍🌾 _— Negócio feito._",
    "",
    "`/comprar` · `/vender` · `/itens` · `/sair`",
  ].join("\n");
}

export function renderMartSaleUnavailable(item: MartSellableInventoryItem): string {
  return [
    "△ *𝗜𝗧𝗘𝗠 𝗜𝗡𝗗𝗜𝗦𝗣𝗢𝗡Í𝗩𝗘𝗟*",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `◇ *${item.displayName}*`,
    "",
    "> _Você não possui unidades suficientes desse item para concluir a venda._",
    "",
    "🧑‍🌾 _— Confira sua mochila e me diga outra quantidade._",
  ].join("\n");
}

export function renderPokemonCenterRecovery(): string {
  return [
    "♡ *𝗥𝗘𝗖𝗨𝗣𝗘𝗥𝗔ÇÃ𝗢*",
    "　Terminal · Equipe Pokémon",
    "",
    "👩‍⚕️ _— Claro. Deixe seus Pokémon comigo por alguns instantes._",
    "",
    "> _As Poké Balls são colocadas cuidadosamente na máquina de recuperação._",
    "",
    "　　　　◉ *PROCESSANDO...*",
    "",
    "♡ HP　　 `████████`　*100%*",
    "⚡ PP　　 `████████`　*100%*",
    "✦ STATUS　`LIMPO`",
    "",
    "　　　　　　　✓",
    "",
    "　　　*𝗥𝗘𝗖𝗨𝗣𝗘𝗥𝗔ÇÃ𝗢 𝗖𝗢𝗡𝗖𝗟𝗨Í𝗗𝗔*",
    "",
    "> ❤️ HP restaurado.",
    "> ⚡ PP restaurado.",
    "> ✨ Condições de status removidas.",
    "",
    "👩‍⚕️ _— Prontinho! Seus Pokémon estão completamente recuperados. Cuide bem deles, treinador._",
  ].join("\n");
}

export function renderCenterConversationMenu(): string {
  return [
    "ᯓ *𝗖𝗢𝗡𝗩𝗘𝗥𝗦𝗔*",
    "　Centro Pokémon · Recepção",
    "",
    "> _Você observa quem está disponível para conversar no salão._",
    "",
    "`01` Enfermeira Hana",
    "`02` Funcionário do Centro",
    "",
    "› _Responda com o número da pessoa._",
  ].join("\n");
}

export function renderCenterHanaConversation(): string {
  return [
    "♡ *𝗘𝗡𝗙𝗘𝗥𝗠𝗘𝗜𝗥𝗔 𝗛𝗔𝗡𝗔*",
    "　Enfermeira Hana · Recepção",
    "",
    "> _Hana apoia as mãos no balcão e lhe dedica um sorriso tranquilo._",
    "",
    "👩‍⚕️ _— A Vila dos Arrozais é o primeiro lugar onde muitos treinadores aprendem a cuidar da própria equipe. Saber quando parar, recuperar seus Pokémon e observar como eles estão também faz parte da jornada._",
    "",
    "‹　`/conversar`",
  ].join("\n");
}

export function renderCenterEmployeeConversation(): string {
  return [
    "▣ *𝗢𝗥𝗜𝗘𝗡𝗧𝗔ÇÃ𝗢*",
    "　Funcionário do Centro · Suporte",
    "",
    "> _Um dos funcionários se aproxima do terminal e aponta para a tela do sistema._",
    "",
    "_— Um treinador pode carregar no máximo seis Pokémon na equipe. Os demais ficam guardados nas caixas do PC e podem ser organizados ou trazidos de volta quando houver espaço._",
    "",
    "‹　`/conversar`",
  ].join("\n");
}

export function renderWorldServiceExit(): string {
  return "‹ *Atendimento encerrado.* Você voltou à cena normal.";
}
