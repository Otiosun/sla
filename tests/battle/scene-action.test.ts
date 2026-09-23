import { describe, expect, it } from "vitest";
import { parseSceneAction } from "../../src/modules/battle/scene-action.js";

describe("scene action contract", () => {
  it.each([
    ["Cena\n/movimento 1", { type: "USE_MOVE", moveRef: "1" }],
    ["_Cena /movimento 2_", { type: "USE_MOVE", moveRef: "2" }],
    ["Cena /movimento Quick Attack", { type: "USE_MOVE", moveRef: "Quick Attack" }],
    ["/trocar 2", { type: "SWITCH", switchSlot: 2 }],
    ["/item pocao", { type: "USE_ITEM", itemRef: "pocao" }],
    ["/capturar 1", { type: "CAPTURE", captureRef: "1" }],
    ["/capturar", { type: "CAPTURE", captureRef: "" }],
    ["Tento recuar. /fugir", { type: "FLEE" }],
    ["Não dá mais. /desistir", { type: "SURRENDER" }],
  ])("parses %s", (text, intent) =>
    expect(parseSceneAction(text)).toEqual({ kind: "ACTION", intent }),
  );

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
