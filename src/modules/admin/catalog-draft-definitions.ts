import {
  CatalogDraftCreateInputSchema,
  CatalogDraftDeactivateInputSchema,
  CatalogDraftInspectInputSchema,
  CatalogDraftReplaceInputSchema,
  type CatalogDraftCreateInput,
  type CatalogDraftDeactivateInput,
  type CatalogDraftInspectInput,
  type CatalogDraftReplaceInput,
} from "../catalog/draft-contracts.js";
import type { AdminCatalogDraftOperationPort } from "./catalog-draft-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const inspectPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const draftMutationPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

export function registerPhase12CCatalogDraftOperations(
  registry: AdminOperationRegistry,
  port: AdminCatalogDraftOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<CatalogDraftInspectInput>({
      kind: "READ",
      operationType: "content.draft.inspect",
      capabilityKey: "content.draft.edit",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: inspectPolicy,
      inputSchema: CatalogDraftInspectInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
    }),
  );

  registry.register(
    defineAdminOperation<CatalogDraftCreateInput>({
      kind: "MUTATION",
      operationType: "content.draft.create",
      capabilityKey: "content.draft.create",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: draftMutationPolicy,
      inputSchema: CatalogDraftCreateInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
      apply: (context, input) =>
        port.applyCatalogDraftCreate(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<CatalogDraftReplaceInput>({
      kind: "MUTATION",
      operationType: "content.draft.replace",
      capabilityKey: "content.draft.edit",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: draftMutationPolicy,
      inputSchema: CatalogDraftReplaceInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
      apply: (context, input) =>
        port.applyCatalogDraftReplace(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<CatalogDraftDeactivateInput>({
      kind: "MUTATION",
      operationType: "content.draft.deactivate",
      capabilityKey: "content.draft.edit",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: draftMutationPolicy,
      inputSchema: CatalogDraftDeactivateInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
      apply: (context, input) =>
        port.applyCatalogDraftDeactivate(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
