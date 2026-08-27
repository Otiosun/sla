import type { AdminOperationRecord } from "./contracts.js";
import {
  AdminBatchExecuteInputSchema,
  AdminBatchPreviewInputSchema,
  type AdminBatchExecuteInput,
  type AdminBatchPreviewInput,
} from "./batch-contracts.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

export interface AdminBatchOperationPort {
  preview(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBatchPreviewInput,
  ): Promise<AdminOperationRecord>;
  execute(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: AdminBatchExecuteInput,
  ): Promise<AdminOperationRecord>;
}

const previewPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const executeLowRiskPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12DBatchAdminOperations(
  registry: AdminOperationRegistry,
  port: AdminBatchOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<AdminBatchPreviewInput>({
      kind: "MUTATION",
      operationType: "batch.preview",
      capabilityKey: "batch.preview",
      riskTier: 2,
      authorizationMode: "GLOBAL_ONLY",
      policy: previewPolicy,
      inputSchema: AdminBatchPreviewInputSchema,
      target: () => ({ type: "ADMIN_BATCH_COLLECTION", id: null }),
      apply: (context, input) =>
        port.preview(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<AdminBatchExecuteInput>({
      kind: "MUTATION",
      operationType: "batch.execute.low_risk",
      capabilityKey: "batch.execute.low_risk",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: executeLowRiskPolicy,
      inputSchema: AdminBatchExecuteInputSchema,
      target: (input) => ({ type: "ADMIN_BATCH", id: input.batchId }),
      apply: (context, input) =>
        port.execute(context.operation, context.actorPrincipalId, input),
    }),
  );

  // batch.execute.high_risk intentionally remains unregistered. High-risk child operations
  // retain their individual R3/R4 confirmation/approval semantics until a dedicated batch
  // policy can preserve those gates without turning batch into an authorization bypass.
  return registry;
}
