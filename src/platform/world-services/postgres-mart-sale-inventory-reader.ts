import type { Pool } from "pg";
import type {
  MartSaleInventoryReader,
  MartSellableInventoryItem,
} from "../../modules/world-services/mart-sale.js";
import type { PlayerId } from "../../shared-kernel/ids.js";
import { ok, type Result } from "../../shared-kernel/result.js";

interface SellableInventoryRow {
  readonly offer_key: string;
  readonly item_id: string;
  readonly display_name: string;
  readonly currency_id: string;
  readonly sale_amount: string;
  readonly inventory_quantity: string;
}

export class PostgresMartSaleInventoryReader implements MartSaleInventoryReader {
  public constructor(private readonly pool: Pool) {}

  public async listSellableInventory(
    playerId: PlayerId,
  ): Promise<Result<readonly MartSellableInventoryItem[]>> {
    const result = await this.pool.query<SellableInventoryRow>(
      `SELECT offer.offer_key,
              offer.item_id,
              item.display_name,
              offer.currency_id,
              offer.sale_amount::text,
              inventory.quantity::text AS inventory_quantity
       FROM content_release_pointers pointer
       JOIN content_releases release
         ON release.id = pointer.content_release_id
        AND release.status = 'PUBLISHED'
       JOIN item_sale_offers offer
         ON offer.content_release_id = release.id
        AND offer.active = TRUE
       JOIN item_revisions item
         ON item.content_release_id = release.id
        AND item.item_id = offer.item_id
        AND item.active = TRUE
       JOIN inventory_balances inventory
         ON inventory.player_id = $1
        AND inventory.item_id = offer.item_id
        AND inventory.quantity > 0
       WHERE pointer.pointer_key = 'ACTIVE'
       ORDER BY offer.sort_order, item.display_name, offer.offer_key`,
      [playerId],
    );

    return ok(
      result.rows.map((row) => ({
        offerKey: row.offer_key,
        itemId: row.item_id,
        displayName: row.display_name,
        currencyId: row.currency_id,
        unitSaleAmount: BigInt(row.sale_amount),
        inventoryQuantity: BigInt(row.inventory_quantity),
      })),
    );
  }
}
