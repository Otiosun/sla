import { describe, expect, it } from "vitest";
import { RuntimeTerminationController } from "../../src/runtime/runtime-termination-controller.js";

describe("RuntimeTerminationController", () => {
  it("preserves the first terminal cause so host shutdown cannot overwrite session invalidation", () => {
    const controller = new RuntimeTerminationController();

    controller.request("INVALIDATED", "LOGGED_OUT");
    controller.request("STOPPED", "SIGTERM");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.termination).toEqual({ state: "INVALIDATED", reason: "LOGGED_OUT" });
  });

  it("records SIGTERM as a normal stopped runtime when it is the first terminal cause", () => {
    const controller = new RuntimeTerminationController();

    controller.request("STOPPED", "SIGTERM");

    expect(controller.termination).toEqual({ state: "STOPPED", reason: "SIGTERM" });
  });

  it("records an unexpected runtime failure only when no prior terminal cause exists", () => {
    const controller = new RuntimeTerminationController();

    controller.recordFailure();
    expect(controller.termination).toEqual({ state: "STOPPED", reason: "RUNTIME_FAILURE" });

    controller.request("INVALIDATED", "PAIRING_REQUIRED");
    expect(controller.termination).toEqual({ state: "STOPPED", reason: "RUNTIME_FAILURE" });
  });
});
