import type { RuntimeInstanceRegistration } from "./postgres-runtime-health.js";

export type RuntimeAppEnvironment = "development" | "test" | "staging" | "production";

export interface ReleaseRuntimeRegistrationInput {
  readonly appEnv: RuntimeAppEnvironment;
  readonly deploymentRevision: string | null;
  readonly whatsappSessionKey: string;
  readonly instanceId: string;
}

export class ReleaseRuntimeRegistrationError extends Error {
  override readonly name = "ReleaseRuntimeRegistrationError";
}

export function createReleaseRuntimeRegistration(
  input: ReleaseRuntimeRegistrationInput,
): RuntimeInstanceRegistration | null {
  const isReleaseEnvironment = input.appEnv === "staging" || input.appEnv === "production";

  if (!isReleaseEnvironment) {
    if (input.deploymentRevision !== null) {
      throw new ReleaseRuntimeRegistrationError(
        "Deployment evidence cannot be created outside staging/production",
      );
    }
    return null;
  }

  if (input.deploymentRevision === null) {
    throw new ReleaseRuntimeRegistrationError(
      "Deployment revision is required for staging/production runtime evidence",
    );
  }

  return {
    instanceId: input.instanceId,
    environment: input.appEnv,
    deploymentRevision: input.deploymentRevision,
    whatsappSessionKey: input.whatsappSessionKey,
  };
}
