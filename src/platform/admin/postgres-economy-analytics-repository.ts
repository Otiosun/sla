import type { Pool } from "pg";
import type {
  EconomyAnalyticsAggregateEvidence,
  EconomyAnalyticsReadRepository,
  EconomyCurrencyAggregateEvidence,
} from "../../modules/admin/economy-analytics-service.js";
import type { AdminEnvironment } from "../../modules/admin/contracts.js";
import { withTransaction } from "../db/transaction.js";

const MIN_CURRENCY_PARTICIPANTS = 5;
const MAX_CURRENCIES = 32;

interface CurrencyRow {
  slug: string;
  display_name: string;
  inflow: string;
  outflow: string;
  net_flow: string;
  total_balance: string;
}

interface InventoryRow {
  inflow_units: string;
  outflow_units: string;
  net_flow_units: string;
  total_units_held: string;
}

interface AnomalyRow {
  wallet_projection_mismatches: string;
  inventory_projection_mismatches: string;
}

function currencyEvidence(row: CurrencyRow): EconomyCurrencyAggregateEvidence {
  return {
    slug: row.slug,
    displayName: row.display_name,
    inflow: row.inflow,
    outflow: row.outflow,
    netFlow: row.net_flow,
    totalBalance: row.total_balance,
  };
}

export class PostgresEconomyAnalyticsRepository implements EconomyAnalyticsReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async readAggregate(
    environment: AdminEnvironment,
    asOf: Date,
  ): Promise<EconomyAnalyticsAggregateEvidence> {
    void environment;

    return withTransaction(
      this.pool,
      async (client) => {
        const currencyResult = await client.query<CurrencyRow>(
          `WITH wallet_flow AS (
             SELECT currency_id,
                    COALESCE(sum(delta) FILTER (WHERE delta > 0), 0)::text AS inflow,
                    COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0)::text AS outflow,
                    COALESCE(sum(delta), 0)::text AS net_flow
             FROM wallet_ledger
             WHERE created_at >= $1::timestamptz - interval '30 days'
               AND created_at < $1::timestamptz
             GROUP BY currency_id
           ), wallet_balance AS (
             SELECT currency_id, COALESCE(sum(amount), 0)::text AS total_balance
             FROM wallet_balances
             GROUP BY currency_id
           ), participants AS (
             SELECT currency_id, count(DISTINCT player_id) AS participant_count
             FROM (
               SELECT currency_id, player_id
               FROM wallet_balances
               UNION
               SELECT currency_id, player_id
               FROM wallet_ledger
               WHERE created_at >= $1::timestamptz - interval '30 days'
                 AND created_at < $1::timestamptz
             ) participant
             GROUP BY currency_id
           )
           SELECT currency.slug,
                  currency.display_name,
                  COALESCE(flow.inflow, '0') AS inflow,
                  COALESCE(flow.outflow, '0') AS outflow,
                  COALESCE(flow.net_flow, '0') AS net_flow,
                  COALESCE(balance.total_balance, '0') AS total_balance
           FROM currency_definitions currency
           JOIN participants ON participants.currency_id = currency.id
           LEFT JOIN wallet_flow flow ON flow.currency_id = currency.id
           LEFT JOIN wallet_balance balance ON balance.currency_id = currency.id
           WHERE participants.participant_count >= $2
             AND (flow.currency_id IS NOT NULL OR balance.currency_id IS NOT NULL)
           ORDER BY currency.slug
           LIMIT $3`,
          [asOf, MIN_CURRENCY_PARTICIPANTS, MAX_CURRENCIES + 1],
        );

        const inventoryResult = await client.query<InventoryRow>(
          `WITH flow AS (
             SELECT COALESCE(sum(delta) FILTER (WHERE delta > 0), 0)::text AS inflow_units,
                    COALESCE(sum(-delta) FILTER (WHERE delta < 0), 0)::text AS outflow_units,
                    COALESCE(sum(delta), 0)::text AS net_flow_units
             FROM inventory_ledger
             WHERE created_at >= $1::timestamptz - interval '30 days'
               AND created_at < $1::timestamptz
           ), balance AS (
             SELECT COALESCE(sum(quantity), 0)::text AS total_units_held
             FROM inventory_balances
           )
           SELECT flow.inflow_units,
                  flow.outflow_units,
                  flow.net_flow_units,
                  balance.total_units_held
           FROM flow CROSS JOIN balance`,
          [asOf],
        );

        const anomalyResult = await client.query<AnomalyRow>(
          `WITH wallet_reconstructed AS (
             SELECT player_id, currency_id, sum(delta) AS reconstructed_amount
             FROM wallet_ledger
             WHERE created_at < $1::timestamptz
             GROUP BY player_id, currency_id
           ), wallet_mismatches AS (
             SELECT count(*)::text AS mismatch_count
             FROM wallet_balances balance
             FULL OUTER JOIN wallet_reconstructed reconstructed
               ON reconstructed.player_id = balance.player_id
              AND reconstructed.currency_id = balance.currency_id
             WHERE COALESCE(reconstructed.reconstructed_amount, 0) <> COALESCE(balance.amount, 0)
           ), inventory_reconstructed AS (
             SELECT player_id, item_id, sum(delta) AS reconstructed_quantity
             FROM inventory_ledger
             WHERE created_at < $1::timestamptz
             GROUP BY player_id, item_id
           ), inventory_mismatches AS (
             SELECT count(*)::text AS mismatch_count
             FROM inventory_balances balance
             FULL OUTER JOIN inventory_reconstructed reconstructed
               ON reconstructed.player_id = balance.player_id
              AND reconstructed.item_id = balance.item_id
             WHERE COALESCE(reconstructed.reconstructed_quantity, 0) <> COALESCE(balance.quantity, 0)
           )
           SELECT wallet_mismatches.mismatch_count AS wallet_projection_mismatches,
                  inventory_mismatches.mismatch_count AS inventory_projection_mismatches
           FROM wallet_mismatches CROSS JOIN inventory_mismatches`,
          [asOf],
        );

        const inventory = inventoryResult.rows[0];
        const anomalies = anomalyResult.rows[0];
        if (inventory === undefined || anomalies === undefined) {
          throw new Error("Economy analytics aggregate query returned no row");
        }

        return {
          currencies: currencyResult.rows.slice(0, MAX_CURRENCIES).map(currencyEvidence),
          currenciesTruncated: currencyResult.rows.length > MAX_CURRENCIES,
          inventory: {
            inflowUnits: inventory.inflow_units,
            outflowUnits: inventory.outflow_units,
            netFlowUnits: inventory.net_flow_units,
            totalUnitsHeld: inventory.total_units_held,
          },
          walletProjectionMismatches: anomalies.wallet_projection_mismatches,
          inventoryProjectionMismatches: anomalies.inventory_projection_mismatches,
        };
      },
      { isolationLevel: "REPEATABLE READ", readOnly: true },
    );
  }
}
