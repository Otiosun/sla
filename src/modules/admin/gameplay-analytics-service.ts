import { AdminEnvironmentSchema, type AdminEnvironment } from "./contracts.js";

export type GameplayAnalyticsWindowKey = "24h" | "7d" | "30d";

export type SuppressedAggregate = { readonly suppressed: true };

export type EncounterCreatedAggregate =
  | SuppressedAggregate
  | {
      readonly suppressed: false;
      readonly count: string;
    };

export type EncounterClosureAggregate =
  | SuppressedAggregate
  | {
      readonly suppressed: false;
      readonly closed: string;
      readonly captured: string;
      readonly fled: string;
      readonly expired: string;
      readonly closedOther: string;
    };

export interface EncounterAggregate {
  readonly created: EncounterCreatedAggregate;
  readonly closures: EncounterClosureAggregate;
}

export type CaptureAggregate =
  | SuppressedAggregate
  | {
      readonly suppressed: false;
      readonly resolved: string;
      readonly captured: string;
      readonly failed: string;
    };

export type TrainerProgressionAggregate =
  | SuppressedAggregate
  | {
      readonly suppressed: false;
      readonly adjustments: string;
      readonly pointsAdded: string;
      readonly pointsRemoved: string;
      readonly netPoints: string;
    };

export interface GameplayAnalyticsWindowEvidence {
  readonly window: GameplayAnalyticsWindowKey;
  readonly encounters: EncounterAggregate;
  readonly captures: CaptureAggregate;
  readonly trainerProgression: TrainerProgressionAggregate;
}

export interface GameplayAnalyticsAggregateEvidence {
  readonly windows: readonly GameplayAnalyticsWindowEvidence[];
}

interface GameplayAnalyticsReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface GameplayAnalyticsReadRepository {
  readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<GameplayAnalyticsAggregateEvidence>;
}

export interface GameplayAnalyticsReadRequest {
  readonly principalId: string;
  readonly environment: AdminEnvironment;
  readonly correlationId: string;
}

export interface GameplayAnalyticsView {
  readonly asOf: string;
  readonly windows: readonly GameplayAnalyticsWindowEvidence[];
}

export class GameplayAnalyticsService {
  public constructor(
    private readonly authorizer: GameplayAnalyticsReadAuthorizer,
    private readonly repository: GameplayAnalyticsReadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAggregate(request: GameplayAnalyticsReadRequest): Promise<GameplayAnalyticsView> {
    const environment = AdminEnvironmentSchema.parse(request.environment);
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "gameplay.analytics.read",
      input: {},
      correlationId: request.correlationId,
    });

    const asOf = this.now();
    const aggregate = await this.repository.readAggregate(environment, asOf);
    return { asOf: asOf.toISOString(), windows: aggregate.windows };
  }
}
