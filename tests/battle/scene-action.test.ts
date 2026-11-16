import { describe, expect, it } from "vitest";
import { parseSceneAction } from "../../src/modules/battle/scene-action.js";

describe("scene action contract", () => {
  it.each([
    ["Cena\n/movimento 1", { type: "USE_MOVE", moveRef: "1" }],
    ["_Cena /movimento 2_", { type: "USE_MOVE", moveRef: "2" }],
    ["Cena /movimento Quick Attack", { type: "USE_MOVE", moveRef: "Quick Attack" }],
    ["/trocar 2", { type: "SWITCH", switchSlot: 2 }],
    ["/trocar 2 e continuo a Cena no mesmo parágrafo", { type: "SWITCH", switchSlot: 2 }],
    ["Eu ergo a mão. /trocar 3, enquanto descrevo o retorno.", { type: "SWITCH", switchSlot: 3 }],
    ["/capturar 1", { type: "CAPTURE", captureRef: "1" }],
    ["/capturar", { type: "CAPTURE", captureRef: "" }],
    ["Tento recuar. /fugir", { type: "FLEE" }],
    ["Não dá mais. /desistir", { type: "SURRENDER" }],
  ])("parses %s", (text, intent) =>
    expect(parseSceneAction(text)).toEqual({ kind: "ACTION", intent }),
  );

  it.each(["/trocar 2abc", "/trocar 2.5", "/trocar 0", "/trocar -2", "/trocar 9999999999999999999999"])(
    "rejects malformed /trocar slot %s without applying an action",
    (input) => expect(parseSceneAction(input)).toEqual({
      kind: "INVALID",
      reason: "INVALID_DIRECTIVE",
    }),
  );

  it("does not recognize the removed /item directive", () =>
    expect(parseSceneAction("/item pocao")).toEqual({ kind: "NONE" }));

  it("does not infer a mechanical action from narrative", () =>
    expect(parseSceneAction("uso ember agora")).toEqual({ kind: "NONE" }));

  it("accepts a command before later narrative because prose is mechanically opaque", () =>
    expect(parseSceneAction("/movimento 1\nmas continuo narrando a cena.")).toEqual({
      kind: "ACTION",
      intent: { type: "USE_MOVE", moveRef: "1" },
    }));

  it("rejects multiple directives", () =>
    expect(parseSceneAction("/movimento 1\n/fugir")).toEqual({
      kind: "INVALID",
      reason: "MULTIPLE_DIRECTIVES",
    }));

  it("rejects legacy dollar commands", () =>
    expect(parseSceneAction("$movimento 1")).toEqual({ kind: "NONE" }));
});
