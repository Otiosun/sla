import { describe, expect, it } from "vitest";
import { withOperationalCommandAliases } from "../../src/modules/messaging/operational-command-aliases.js";
import {
  createOperationalUxRoutes,
  type OperationalUxDependencies,
} from "../../src/modules/messaging/operational-ux-handlers.js";

const EXPECTED_ALIASES = {
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
} as const;

describe("operational command aliases", () => {
  it("declares a small explicit alias vocabulary without duplicating accent variants", () => {
    const routes = withOperationalCommandAliases(
      createOperationalUxRoutes({} as OperationalUxDependencies),
    );
    const aliasesByCommand = new Map(
      routes.map((route) => [route.command, route.aliases ?? []]),
    );

    for (const [command, aliases] of Object.entries(EXPECTED_ALIASES)) {
      expect(aliasesByCommand.get(command)).toEqual(aliases);
    }

    expect(aliasesByCommand.get("regioes") ?? []).not.toContain("regiões");
    expect(aliasesByCommand.get("regiao") ?? []).not.toContain("região");
    expect(aliasesByCommand.get("inventario") ?? []).not.toContain("inventário");
    expect(aliasesByCommand.get("pokedex") ?? []).not.toContain("pokédex");
  });
});
