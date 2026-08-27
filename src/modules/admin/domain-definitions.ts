import {
  AdminInventoryAdjustInputSchema,
  type AdminInventoryAdjustInput,
  AdminWalletAdjustInputSchema,
  type AdminWalletAdjustInput,
} from "./domain-contracts.js";
import type { AdminDomainOperationPort } from "./domain-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const deltaPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

export function registerPhase12CDomainAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminDomainOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminInventoryAdjustInput>({
      kind: "MUTATION",
      operationType: "inventory.adjust",
      capabilityKey: "inventory.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminInventoryAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyInventoryAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminWalletAdjustInput>({
      kind: "MUTATION",
      operationType: "wallet.adjust",
      capabilityKey: "wallet.adjust",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: deltaPolicy,
      inputSchema: AdminWalletAdjustInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyWalletAdjustment(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
