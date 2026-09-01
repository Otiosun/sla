import type { AdminEnvironment } from "./contracts.js";

export type RuntimeProviderState =
  | "STARTING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "STOPPED"
  | "INVALIDATED";

export interface RuntimeWhatsappHealthEvidence {
  readonly providerState: RuntimeProviderState;
  readonly deploymentRevision: string;
  readonly startedAt: Date;
  readonly lastConnectedAt: Date | null;
  readonly lastHeartbeatAt: Date;
  readonly lastDisconnectAt: Date | null;
  readonly stoppedAt: Date | null;
}

export interface RuntimeWhatsappHealthRuntimeView {
  readonly providerState: RuntimeProviderState;
  readonly deploymentRevision: string;
  readonly startedAt: string;
  readonly lastConnectedAt: string | null;
  readonly lastHeartbeatAt: string;
  readonly lastDisconnectAt: string | null;
  readonly stoppedAt: string | null;
}

export interface RuntimeWhatsappHealthView {
  readonly environment: AdminEnvironment;
  readonly runtime: RuntimeWhatsappHealthRuntimeView | null;
}

export interface RuntimeWhatsappHealthReadRepository {
  findLatest(environment: "staging" | "production"): Promise<RuntimeWhatsappHealthEvidence | null>;
}
