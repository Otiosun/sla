import {
  AdminEncounterCloseInputSchema,
  AdminEncounterInspectInputSchema,
  type AdminEncounterCloseInput,
  type AdminEncounterInspectInput,
} from "./domain-contracts.js";
import type { AdminEncounterOperationPort } from "./encounter-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const inspectPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const closePolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12CEncounterAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminEncounterOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminEncounterInspectInput>({
      kind: "READ",
      operationType: "encounter.inspect",
      capabilityKey: "encounter.support",
      riskTier: 1,
      authorizationMode: "SUBJECT",
      policy: inspectPolicy,
      inputSchema: AdminEncounterInspectInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation<AdminEncounterCloseInput>({
      kind: "MUTATION",
      operationType: "encounter.close",
      capabilityKey: "encounter.force_close",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: closePolicy,
      inputSchema: AdminEncounterCloseInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyEncounterClose(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
