import { describe, expect, it } from "vitest";
import { ManualMasterBallPackSchema } from "../../src/modules/premium-orders/manual-master-ball-pack-contracts.js";
describe("Master Ball delivery", () => {
  it("requires the exact SKU and no payment fields", () => {
    const input = { requestId: "11111111-1111-4111-8111-111111111111", playerId: "22222222-2222-4222-8222-222222222222", sku: "MASTER", quantity: 2, reason: "Concessão autorizada manualmente." };
    expect(ManualMasterBallPackSchema.safeParse(input).success).toBe(true);
    expect(ManualMasterBallPackSchema.safeParse({ ...input, sku: "P-U" }).success).toBe(false);
    expect(ManualMasterBallPackSchema.safeParse({ ...input, paid: true }).success).toBe(false);
    expect(ManualMasterBallPackSchema.safeParse({ ...input, quantity: 21 }).success).toBe(false);
  });
});
