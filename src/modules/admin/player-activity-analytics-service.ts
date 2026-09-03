import { AdminEnvironmentSchema, type AdminEnvironment } from "./contracts.js";

interface PlayerActivityReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface PlayerActivityAggregateEvidence {
  readonly last24Hours: number;
  readonly last7Days: number;
  readonly last30Days: number;
  readonly returningPlayers7Days: number;
}

export interface PlayerActivityAnalyticsReadRepository {
  readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<PlayerActivityAggregateEvidence>;
}

export interface PlayerActivityAnalyticsReadRequest {
  readonly principalId: string;
  readonly environment: AdminEnvironment;
  readonly correlationId: string;
}

export interface PlayerActivityAnalyticsView {
  readonly asOf: string;
  readonly activePlayers: {
    readonly last24Hours: number;
    readonly last7Days: number;
    readonly last30Days: number;
  };
  readonly returningPlayers7Days: number;
}

export class PlayerActivityAnalyticsService {
  public constructor(
    private readonly authorizer: PlayerActivityReadAuthorizer,
    private readonly repository: PlayerActivityAnalyticsReadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAggregate(
    request: PlayerActivityAnalyticsReadRequest,
  ): Promise<PlayerActivityAnalyticsView> {
    const environment = AdminEnvironmentSchema.parse(request.environment);
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "player.activity.read",
      input: {},
      correlationId: request.correlationId,
    });

    const asOf = this.now();
    const aggregate = await this.repository.readAggregate(environment, asOf);
    return {
      asOf: asOf.toISOString(),
      activePlayers: {
        last24Hours: aggregate.last24Hours,
        last7Days: aggregate.last7Days,
        last30Days: aggregate.last30Days,
      },
      returningPlayers7Days: aggregate.returningPlayers7Days,
    };
  }
}
