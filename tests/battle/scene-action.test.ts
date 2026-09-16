import { describe, expect, it } from "vitest";
import { parseSceneAction } from "../../src/modules/battle/scene-action.js";

describe("scene action contract", () => {
  it.each([
    ["Cena\n/movimento 1", { type: "USE_MOVE", moveSlot: 1 }],
    ["/trocar 2", { type: "SWITCH", switchSlot: 2 }],
    ["/item pocao", { type: "USE_ITEM", itemRef: "pocao" }],
    ["/capturar 1", { type: "CAPTURE", captureRef: "1" }],
    ["/capturar", { type: "CAPTURE", captureRef: "" }],
    ["/fugir", { type: "FLEE" }],
    ["/desistir", { type: "SURRENDER" }],
  ])("parses %s", (text, intent) =>
    expect(parseSceneAction(text)).toEqual({ kind: "ACTION", intent }),
  );

  it("does not infer a mechanical action from narrative", () =>
    expect(parseSceneAction("uso ember agora")).toEqual({ kind: "NONE" }));
  it("rejects multiple directives", () =>
    expect(parseSceneAction("/movimento 1\n/movimento 2")).toEqual({
      kind: "INVALID",
      reason: "MULTIPLE_DIRECTIVES",
    }));
  it("rejects a directive outside the final non-empty line", () =>
    expect(parseSceneAction("/movimento 1\nnarrativa")).toEqual({
      kind: "INVALID",
      reason: "DIRECTIVE_NOT_FINAL",
    }));
  it("rejects legacy dollar commands", () =>
    expect(parseSceneAction("$movimento 1")).toEqual({ kind: "NONE" }));
});
