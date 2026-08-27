import {
  AdminBattleCorrectStateInputSchema,
  AdminBattleForceCancelInputSchema,
  AdminBattleTargetSchema,
  type AdminBattleCorrectStateInput,
  type AdminBattleForceCancelInput,
  type AdminBattleTarget,
} from "./battle-contracts.js";
import type { AdminBattleOperationPort } from "./battle-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const inspectPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const battleMutationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12CBattleAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminBattleOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminBattleTarget>({
      kind: "READ",
      operationType: "battle.inspect",
      capabilityKey: "battle.support",
      riskTier: 1,
      authorizationMode: "SUBJECT",
      policy: inspectPolicy,
      inputSchema: AdminBattleTargetSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
    }),
  );

  registry.register(
    defineAdminOperation<AdminBattleForceCancelInput>({
      kind: "MUTATION",
      operationType: "battle.force_cancel",
      capabilityKey: "battle.force_cancel",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: battleMutationPolicy,
      inputSchema: AdminBattleForceCancelInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyBattleForceCancel(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminBattleCorrectStateInput>({
      kind: "MUTATION",
      operationType: "battle.correct_state",
      capabilityKey: "battle.correct_state",
      riskTier: 3,
      authorizationMode: "SUBJECT",
      policy: battleMutationPolicy,
      inputSchema: AdminBattleCorrectStateInputSchema,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) =>
        port.applyBattleStateCorrection(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
