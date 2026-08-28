import {
  AdminCompensationInputSchema,
  type AdminCompensationInput,
} from "./compensation-contracts.js";
import type { AdminCompensationOperationPort } from "./compensation-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const compensationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12CompensationOperation(
  registry: AdminOperationRegistry,
  port: AdminCompensationOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminCompensationInput>({
      kind: "MUTATION",
      operationType: "admin.operation.compensate",
      capabilityKey: "admin_operation.compensate",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: compensationPolicy,
      inputSchema: AdminCompensationInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyCompensation(context.operation, context.actorPrincipalId, input),
    }),
  );
  return registry;
}
