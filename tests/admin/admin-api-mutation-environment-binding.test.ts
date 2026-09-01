import { describe, expect, it, vi } from "vitest";
import { AdminMutationFacade } from "../../src/adapters/admin-api/mutation-facade.js";
import type { AdminPreparedOperation } from "../../src/modules/admin/contracts.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";

describe("AdminMutationFacade environment binding", () => {
  it("binds admin.session.revoke_all to the authenticated environment and ignores client input", async () => {
    const prepared = { operation: {}, replayed: false } as AdminPreparedOperation;
    const prepareMutation = vi.fn(async (_request: unknown) => prepared);
    const facade = new AdminMutationFacade({ prepareMutation });

    await expect(
      facade.prepareMutation(
        {
          principalId: PRINCIPAL_ID,
          environment: "staging",
          correlationId: CORRELATION_ID,
        },
        {
          operationType: "admin.session.revoke_all",
          input: { principalId: TARGET_ID, environment: "production" },
          reason: "security incident",
          idempotencyKey: "revoke-all-environment-binding-0001",
        },
      ),
    ).resolves.toBe(prepared);

    expect(prepareMutation).toHaveBeenCalledWith({
      principalId: PRINCIPAL_ID,
      operationType: "admin.session.revoke_all",
      input: { principalId: TARGET_ID, environment: "staging" },
      reason: "security incident",
      idempotencyKey: "revoke-all-environment-binding-0001",
      correlationId: CORRELATION_ID,
    });
  });
});
