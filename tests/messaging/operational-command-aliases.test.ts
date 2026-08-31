import { describe, expect, it } from "vitest";
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
    const routes = createOperationalUxRoutes({} as OperationalUxDependencies);
    const aliasesByCommand = new Map(
      routes.map((route) => [
        route.command,
        (route as typeof route & { readonly aliases?: readonly string[] }).aliases ?? [],
      ]),
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
