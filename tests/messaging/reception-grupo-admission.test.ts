import { describe, expect, it } from "vitest";
import { ReceptionCommandScopeGate } from "../../src/modules/community/reception-message-scope.js";
import type { MessageHandlerContext } from "../../src/modules/messaging/contracts.js";

const context = {
  message: { provider: "baileys", chatRef: "120363000000000001@g.us" },
} as MessageHandlerContext;

describe("Reception /grupo access on Premium live baseline", () => {
  const gate = new ReceptionCommandScopeGate({
    resolveChat: async () => ({
      known: true as const,
      groupId: "00000000-0000-4000-8000-000000000911",
      role: "RECEPTION" as const,
      capabilities: ["onboarding" as const, "admin.review" as const],
    }),
  });

  it("lets /grupo reach the existing global admin authorization", async () => {
    expect(await gate.admits(context, "grupo")).toBe(true);
  });

  it("keeps all gameplay blocked in Reception", async () => {
    for (const command of ["spawn", "iniciarbatalha", "desafiar", "pescar", "comprar"]) {
      expect(await gate.admits(context, command)).toBe(false);
    }
  });
});
