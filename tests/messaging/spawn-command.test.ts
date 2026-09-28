import { describe, expect, it } from "vitest";
import { parseSpawnCommand } from "../../src/modules/encounter/spawn-command.js";

describe("spawn director command parser", () => {
  it("keeps the simple random spawn path", () => {
    expect(parseSpawnCommand("/spawn @Migueel")).toEqual({
      ok: true,
      value: {
        automatic: false,
        quantity: 1,
        speciesReference: null,
        forcedLevel: null,
        forcedShiny: false,
        firstTurn: null,
        openingMoveReference: null,
      },
    });
  });

  it("parses flexible narrator modifiers without requiring a rigid order", () => {
    expect(
      parseSpawnCommand(
        "/spawn @Migueel shiny ataque Bite Poochyena inicio selvagem nv 12",
      ),
    ).toEqual({
      ok: true,
      value: {
        automatic: false,
        quantity: 1,
        speciesReference: "Poochyena",
        forcedLevel: 12,
        forcedShiny: true,
        firstTurn: "WILD",
        openingMoveReference: "Bite",
      },
    });
  });

  it.each([
    ["/spawn Poochyena @Migueel nv12", 12],
    ["/spawn Poochyena @Migueel nivel 23", 23],
    ["/spawn Poochyena @Migueel level 5", 5],
    ["/spawn Poochyena @Migueel lvl 99", 99],
  ])("accepts human level aliases: %s", (command, level) => {
    const parsed = parseSpawnCommand(command);
    expect(parsed.ok && parsed.value.forcedLevel).toBe(level);
  });

  it.each([
    "/spawn Poochyena @Migueel atk Bite",
    "/spawn Poochyena @Migueel mov Bite",
    "/spawn Poochyena @Migueel movimento Bite",
  ])("accepts opening-move aliases: %s", (command) => {
    const parsed = parseSpawnCommand(command);
    expect(parsed.ok && parsed.value.openingMoveReference).toBe("Bite");
  });

  it("preserves the old trailing quantity syntax and supports explicit qtd", () => {
    expect(parseSpawnCommand("/spawn @Migueel 3")).toMatchObject({
      ok: true,
      value: { quantity: 3, speciesReference: null },
    });
    expect(parseSpawnCommand("/spawn Poochyena @Migueel qtd 2")).toMatchObject({
      ok: true,
      value: { quantity: 2, speciesReference: "Poochyena" },
    });
  });

  it("rejects ambiguous or mechanically unsafe combinations before RNG", () => {
    expect(parseSpawnCommand("/spawn Poochyena @Migueel auto ataque Bite")).toMatchObject({
      ok: false,
    });
    expect(parseSpawnCommand("/spawn Poochyena @Migueel qtd 2 ataque Bite")).toMatchObject({
      ok: false,
    });
    expect(parseSpawnCommand("/spawn Poochyena @Migueel nv 5 nv 8")).toMatchObject({
      ok: false,
    });
    expect(parseSpawnCommand("/spawn Poochyena @Migueel inicio jogador inicio selvagem")).toMatchObject({
      ok: false,
    });
  });

  it("rejects invalid ranges", () => {
    expect(parseSpawnCommand("/spawn Poochyena @Migueel nv 0")).toMatchObject({ ok: false });
    expect(parseSpawnCommand("/spawn Poochyena @Migueel nv 101")).toMatchObject({ ok: false });
    expect(parseSpawnCommand("/spawn @Migueel qtd 7")).toMatchObject({ ok: false });
  });
});
