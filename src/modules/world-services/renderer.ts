import type { WorldServiceKind } from "./contracts.js";

export function renderWorldServiceEntry(kind: WorldServiceKind): string {
  switch (kind) {
    case "POKEMART":
      return [
        "🛒 *POKÉ MART*",
        "",
        "Você entrou no Poké Mart.",
        "As opções de compra e venda serão mostradas por este atendimento.",
        "",
        "Use `/sair` quando quiser encerrar a visita.",
      ].join("\n");
    case "POKEMON_CENTER":
      return [
        "🏥 *CENTRO POKÉMON*",
        "",
        "Você entrou no Centro Pokémon.",
        "O atendimento de cura será mostrado por esta visita.",
        "",
        "Use `/sair` quando quiser encerrar a visita.",
      ].join("\n");
    case "PC":
      return [
        "💻 *PC POKÉMON*",
        "",
        "O PC está aberto para gerenciamento da sua equipe e Boxes.",
        "",
        "Use `/sair` quando quiser fechar o PC.",
      ].join("\n");
  }
}

export function renderWorldServiceExit(): string {
  return "✅ Atendimento encerrado. Você voltou à cena normal.";
}
