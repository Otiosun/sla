import { z } from "zod";
import { AdminBatchExecuteInputSchema, type AdminBatchExecuteInput } from "./batch-contracts.js";
import type { AdminBatchOperationPort } from "./batch-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const previewReadSchema = z.object({}).strict();
const inspectReadSchema = z.object({ batchId: z.string().uuid() }).strict();

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const lowRiskBatchPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: true,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

const highRiskBatchPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: true,
  requiresConfirmation: true,
  requiredApprovals: 1,
} as const;

export function registerPhase12CBatchAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminBatchOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "batch.preview",
      capabilityKey: "batch.preview",
      riskTier: 2,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: previewReadSchema,
      target: () => ({ type: "ADMIN_BATCH_COLLECTION", id: null }),
    }),
  );

  registry.register(
    defineAdminOperation({
      kind: "READ",
      operationType: "batch.inspect",
      capabilityKey: "batch.preview",
      riskTier: 2,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: inspectReadSchema,
      target: (input) => ({ type: "ADMIN_BATCH", id: input.batchId }),
    }),
  );

  registry.register(
    defineAdminOperation<AdminBatchExecuteInput>({
      kind: "MUTATION",
      operationType: "batch.execute.low_risk",
      capabilityKey: "batch.execute.low_risk",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: lowRiskBatchPolicy,
      inputSchema: AdminBatchExecuteInputSchema,
      target: (input) => ({ type: "ADMIN_BATCH", id: input.batchId }),
      simulate: (input) => port.simulateBatchExecution(input, 3),
      apply: (context, input) =>
        port.applyBatchExecution(context.operation, context.actorPrincipalId, input, 3),
    }),
  );

  registry.register(
    defineAdminOperation<AdminBatchExecuteInput>({
      kind: "MUTATION",
      operationType: "batch.execute.high_risk",
      capabilityKey: "batch.execute.high_risk",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: highRiskBatchPolicy,
      inputSchema: AdminBatchExecuteInputSchema,
      target: (input) => ({ type: "ADMIN_BATCH", id: input.batchId }),
      simulate: (input) => port.simulateBatchExecution(input, 4),
      apply: (context, input) =>
        port.applyBatchExecution(context.operation, context.actorPrincipalId, input, 4),
    }),
  );

  return registry;
}
