import type {
  CatalogReleaseDiffInput,
  CatalogReleaseLifecycleInput,
} from "../catalog/release-admin-contracts.js";
import {
  CatalogReleaseDiffInputSchema,
  CatalogReleaseLifecycleInputSchema,
} from "../catalog/release-admin-contracts.js";
import type { AdminCatalogReleaseOperationPort } from "./catalog-release-ports.js";
import { type AdminOperationRegistry, defineAdminOperation } from "./operation-registry.js";

const readPolicy = {
  version: 1,
  requiresReason: false,
  requiresExpectedRevision: false,
  requiresSimulation: false,
  requiresConfirmation: false,
  requiredApprovals: 0,
} as const;

const validatePolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: false,
  requiresConfirmation: true,
  requiredApprovals: 0,
} as const;

const publishPolicy = {
  version: 1,
  requiresReason: true,
  requiresExpectedRevision: true,
  requiresSimulation: true,
  requiresConfirmation: true,
  requiredApprovals: 1,
} as const;

export function registerPhase12CCatalogReleaseOperations(
  registry: AdminOperationRegistry,
  port: AdminCatalogReleaseOperationPort,
): AdminOperationRegistry {
  registry.register(
    defineAdminOperation<CatalogReleaseDiffInput>({
      kind: "READ",
      operationType: "content.release.diff",
      capabilityKey: "content.validate",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: readPolicy,
      inputSchema: CatalogReleaseDiffInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.toReleaseId }),
    }),
  );

  registry.register(
    defineAdminOperation<CatalogReleaseLifecycleInput>({
      kind: "MUTATION",
      operationType: "content.release.validate",
      capabilityKey: "content.validate",
      riskTier: 3,
      authorizationMode: "GLOBAL_ONLY",
      policy: validatePolicy,
      inputSchema: CatalogReleaseLifecycleInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
      apply: (context, input) =>
        port.applyCatalogReleaseValidate(context.operation, context.actorPrincipalId, input),
    }),
  );

  registry.register(
    defineAdminOperation<CatalogReleaseLifecycleInput>({
      kind: "MUTATION",
      operationType: "content.release.publish",
      capabilityKey: "content.publish",
      riskTier: 4,
      authorizationMode: "GLOBAL_ONLY",
      policy: publishPolicy,
      inputSchema: CatalogReleaseLifecycleInputSchema,
      target: (input) => ({ type: "CONTENT_RELEASE", id: input.releaseId }),
      simulate: (input) => port.simulateCatalogReleasePublish(input),
      apply: (context, input) =>
        port.applyCatalogReleasePublish(context.operation, context.actorPrincipalId, input),
    }),
  );

  return registry;
}
