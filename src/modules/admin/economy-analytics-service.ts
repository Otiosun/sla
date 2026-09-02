import { AdminEnvironmentSchema, type AdminEnvironment } from "./contracts.js";

interface EconomyAnalyticsReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface EconomyCurrencyAggregateEvidence {
  readonly slug: string;
  readonly displayName: string;
  readonly inflow: string;
  readonly outflow: string;
  readonly netFlow: string;
  readonly totalBalance: string;
}

export interface EconomyAnalyticsAggregateEvidence {
  readonly currencies: readonly EconomyCurrencyAggregateEvidence[];
  readonly currenciesTruncated: boolean;
  readonly inventory: {
    readonly inflowUnits: string;
    readonly outflowUnits: string;
    readonly netFlowUnits: string;
    readonly totalUnitsHeld: string;
  };
  readonly walletProjectionMismatches: string;
  readonly inventoryProjectionMismatches: string;
}

export interface EconomyAnalyticsReadRepository {
  readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<EconomyAnalyticsAggregateEvidence>;
}

export interface EconomyAnalyticsReadRequest {
  readonly principalId: string;
  readonly environment: AdminEnvironment;
  readonly correlationId: string;
}

export interface EconomyAnalyticsView {
  readonly asOf: string;
  readonly window: "30d";
  readonly currencies: readonly EconomyCurrencyAggregateEvidence[];
  readonly currenciesTruncated: boolean;
  readonly inventory: {
    readonly inflowUnits: string;
    readonly outflowUnits: string;
    readonly netFlowUnits: string;
    readonly totalUnitsHeld: string;
  };
  readonly anomalies: {
    readonly walletProjectionMismatches: string;
    readonly inventoryProjectionMismatches: string;
  };
}

export class EconomyAnalyticsService {
  public constructor(
    private readonly authorizer: EconomyAnalyticsReadAuthorizer,
    private readonly repository: EconomyAnalyticsReadRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAggregate(request: EconomyAnalyticsReadRequest): Promise<EconomyAnalyticsView> {
    const environment = AdminEnvironmentSchema.parse(request.environment);
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "economy.analytics.read",
      input: {},
      correlationId: request.correlationId,
    });

    const asOf = this.now();
    const aggregate = await this.repository.readAggregate(environment, asOf);
    return {
      asOf: asOf.toISOString(),
      window: "30d",
      currencies: aggregate.currencies,
      currenciesTruncated: aggregate.currenciesTruncated,
      inventory: aggregate.inventory,
      anomalies: {
        walletProjectionMismatches: aggregate.walletProjectionMismatches,
        inventoryProjectionMismatches: aggregate.inventoryProjectionMismatches,
      },
    };
  }
}
