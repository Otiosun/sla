import { AdminEnvironmentSchema, type AdminEnvironment } from "./contracts.js";
import type {
  RuntimeWhatsappHealthEvidence,
  RuntimeWhatsappHealthReadRepository,
  RuntimeWhatsappHealthRuntimeView,
  RuntimeWhatsappHealthView,
} from "./runtime-health-contracts.js";

interface RuntimeHealthReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface RuntimeWhatsappHealthReadRequest {
  readonly principalId: string;
  readonly environment: AdminEnvironment;
  readonly correlationId: string;
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toRuntimeView(evidence: RuntimeWhatsappHealthEvidence): RuntimeWhatsappHealthRuntimeView {
  return {
    providerState: evidence.providerState,
    deploymentRevision: evidence.deploymentRevision,
    startedAt: evidence.startedAt.toISOString(),
    lastConnectedAt: toIso(evidence.lastConnectedAt),
    lastHeartbeatAt: evidence.lastHeartbeatAt.toISOString(),
    lastDisconnectAt: toIso(evidence.lastDisconnectAt),
    stoppedAt: toIso(evidence.stoppedAt),
  };
}

export class RuntimeWhatsappHealthService {
  public constructor(
    private readonly authorizer: RuntimeHealthReadAuthorizer,
    private readonly repository: RuntimeWhatsappHealthReadRepository,
  ) {}

  public async getLatest(request: RuntimeWhatsappHealthReadRequest): Promise<RuntimeWhatsappHealthView> {
    const environment = AdminEnvironmentSchema.parse(request.environment);
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "runtime.whatsapp.health.read",
      input: {},
      correlationId: request.correlationId,
    });

    if (environment === "development") {
      return { environment, runtime: null };
    }

    const evidence = await this.repository.findLatest(environment);
    return {
      environment,
      runtime: evidence === null ? null : toRuntimeView(evidence),
    };
  }
}
