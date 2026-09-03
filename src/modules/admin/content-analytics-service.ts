import { AdminEnvironmentSchema, type AdminEnvironment } from "./contracts.js";

interface ContentAnalyticsReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface ContentAnalyticsAggregateEvidence {
  readonly encounters: {
    readonly created: string;
    readonly closed: string;
  };
  readonly captures: {
    readonly attemptsCreated: string;
    readonly captured: string;
    readonly failed: string;
  };
  readonly progression: {
    readonly xpAwards: string;
    readonly xpAwarded: string;
    readonly evolutions: string;
  };
}

export interface ContentAnalyticsReadRepository {
  readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<ContentAnalyticsAggregateEvidence>;
}

export interface ContentAnalyticsReadRequest {
  readonly principalId: string;
  readonly environment: AdminEnvironment;
  readonly correlationId: string;
}

export interface ContentAnalyticsView extends ContentAnalyticsAggregateEvidence {
  readonly asOf: string;
  readonly window: "30d";
}

export class ContentAnalyticsService {
  public constructor(
    private readonly authorizer: ContentAnalyticsReadAuthorizer,
    private readonly repository: ContentAnalyticsReadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAggregate(request: ContentAnalyticsReadRequest): Promise<ContentAnalyticsView> {
    const environment = AdminEnvironmentSchema.parse(request.environment);
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "content.analytics.read",
      input: {},
      correlationId: request.correlationId,
    });

    const asOf = this.now();
    const aggregate = await this.repository.readAggregate(environment, asOf);
    return {
      asOf: asOf.toISOString(),
      window: "30d",
      ...aggregate,
    };
  }
}
