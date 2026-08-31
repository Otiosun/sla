import type { CommandRouteDefinition } from "./router.js";

const OPERATIONAL_COMMAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  menu: ["ajuda", "comandos"],
  registrar: ["cadastro"],
  starters: ["iniciais"],
  starter: ["inicial"],
  concluir: ["finalizar"],
  equipe: ["time"],
  inventario: ["inv", "mochila"],
  pokedex: ["dex"],
  onde: ["local"],
  ir: ["viajar"],
};

export function withOperationalCommandAliases(
  definitions: readonly CommandRouteDefinition[],
): readonly CommandRouteDefinition[] {
  return definitions.map((definition) => {
    const aliases = OPERATIONAL_COMMAND_ALIASES[definition.command];
    return aliases === undefined ? definition : { ...definition, aliases };
  });
}
