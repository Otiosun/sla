import { describe, expect, it, vi } from "vitest";
import { AdminMutationFacade } from "../../src/adapters/admin-api/mutation-facade.js";
import { ADMIN_ERROR_CODES } from "../../src/modules/admin/errors.js";
import type { AdminPreparedOperation } from "../../src/modules/admin/contracts.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const PLAYER_ID = "33333333-3333-4333-8333-333333333333";

function harness() {
  const prepared = { operation: {}, replayed: false } as AdminPreparedOperation;
  const prepareMutation = vi.fn(async (_request: unknown) => prepared);
  const facade = new AdminMutationFacade({ prepareMutation });
  return { facade, prepareMutation, prepared };
}

const trustedContext = {
  principalId: PRINCIPAL_ID,
  environment: "staging",
  correlationId: CORRELATION_ID,
};

const clientBody = {
  operationType: "inventory.adjust",
  input: { playerId: PLAYER_ID, delta: 1 },
  reason: "Suporte solicitado pelo jogador",
  expectedRevision: "7",
  idempotencyKey: "support-adjust-0001",
};

describe("AdminMutationFacade", () => {
  it("injects principal and correlation exclusively from trusted server context", async () => {
    const { facade, prepareMutation, prepared } = harness();

    await expect(facade.prepareMutation(trustedContext, clientBody)).resolves.toBe(prepared);

    expect(prepareMutation).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "inventory.adjust",
      input: { playerId: PLAYER_ID, delta: 1 },
      reason: "Suporte solicitado pelo jogador",
      expectedRevision: 7n,
      idempotencyKey: "support-adjust-0001",
      correlationId: CORRELATION_ID,
    });
  });

  it.each(["principalId", "correlationId", "environment"] as const)(
    "rejects browser-controlled authority field %s before the mutation endpoint",
    async (field) => {
      const { facade, prepareMutation } = harness();

      await expect(
        facade.prepareMutation(trustedContext, {
          ...clientBody,
          [field]: field === "environment" ? "production" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.INVALID_INPUT });

      expect(prepareMutation).not.toHaveBeenCalled();
    },
  );

  it("fails closed on malformed trusted context before the mutation endpoint", async () => {
    const { facade, prepareMutation } = harness();

    await expect(
      facade.prepareMutation(
        { principalId: "attacker", environment: "staging", correlationId: CORRELATION_ID },
        clientBody,
      ),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.AUTHORIZATION_DENIED });

    expect(prepareMutation).not.toHaveBeenCalled();
  });

  it("rejects unknown mutation body fields rather than forwarding them", async () => {
    const { facade, prepareMutation } = harness();

    await expect(
      facade.prepareMutation(trustedContext, { ...clientBody, rawSql: "UPDATE players SET ..." }),
    ).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.INVALID_INPUT });

    expect(prepareMutation).not.toHaveBeenCalled();
  });
});
