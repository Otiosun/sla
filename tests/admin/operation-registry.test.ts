import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdminError } from "../../src/modules/admin/errors.js";
import {
  AdminOperationRegistry,
  adminRequestFingerprint,
  defineAdminOperation,
} from "../../src/modules/admin/operation-registry.js";

const readDefinition = defineAdminOperation({
  kind: "READ",
  operationType: "player.read",
  capabilityKey: "player.read",
  riskTier: 0,
  authorizationMode: "SUBJECT",
  policy: {
    version: 1,
    requiresReason: false,
    requiresExpectedRevision: false,
    requiresSimulation: false,
    requiresConfirmation: false,
    requiredApprovals: 0,
  },
  inputSchema: z.object({ playerId: z.string().uuid() }).strict(),
  target: (input) => ({ type: "PLAYER", id: input.playerId }),
});

describe("AdminOperationRegistry", () => {
  it("rejects duplicate operation types", () => {
    const registry = new AdminOperationRegistry().register(readDefinition);
    expect(() => registry.register(readDefinition)).toThrow(AdminError);
  });

  it("uses strict schemas to reject mass assignment", () => {
    expect(() =>
      readDefinition.parseInput({
        playerId: "11111111-1111-4111-8111-111111111111",
        status: "ACTIVE",
      }),
    ).toThrow(AdminError);
  });

  it("fingerprints semantic input independent of object key order", () => {
    const principalId = "22222222-2222-4222-8222-222222222222";
    const target = { type: "PLAYER", id: "11111111-1111-4111-8111-111111111111" };
    const first = adminRequestFingerprint({
      principalId,
      definition: readDefinition,
      parsedInput: { playerId: target.id, nested: { b: 2, a: 1 } },
      target,
      reason: null,
      expectedRevision: null,
    });
    const second = adminRequestFingerprint({
      principalId,
      definition: readDefinition,
      parsedInput: { nested: { a: 1, b: 2 }, playerId: target.id },
      target,
      reason: null,
      expectedRevision: null,
    });
    expect(first).toBe(second);
  });

  it("refuses mutation gates on read definitions", () => {
    expect(() =>
      defineAdminOperation({
        kind: "READ",
        operationType: "bad.read",
        capabilityKey: "player.read",
        riskTier: 0,
        authorizationMode: "SUBJECT",
        policy: {
          version: 1,
          requiresReason: false,
          requiresExpectedRevision: false,
          requiresSimulation: false,
          requiresConfirmation: true,
          requiredApprovals: 0,
        },
        inputSchema: z.object({}).strict(),
        target: () => ({ type: "PLAYER", id: null }),
      }),
    ).toThrow(AdminError);
  });
});
