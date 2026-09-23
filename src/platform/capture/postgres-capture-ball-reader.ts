import type { Pool } from "pg";
import type {
  PveCaptureBallOption,
  PveCaptureBallReader,
} from "../../modules/battle/pve-scene-whatsapp.js";
import type { PlayerId } from "../../shared-kernel/ids.js";

export class PostgresCaptureBallReader implements PveCaptureBallReader {
  public constructor(private readonly pool: Pool) {}

  public async listAvailable(
    playerId: PlayerId,
    contentReleaseId: string,
  ): Promise<readonly PveCaptureBallOption[]> {
    const result = await this.pool.query<{
      item_id: string;
      display_name: string;
      quantity: string;
    }>(
      `SELECT balance.item_id,
              revision.display_name,
              balance.quantity::text
       FROM inventory_balances balance
       JOIN item_revisions revision
         ON revision.item_id = balance.item_id
        AND revision.content_release_id = $2
        AND revision.active = TRUE
       WHERE balance.player_id = $1
         AND balance.quantity > 0
         AND revision.item_kind = 'BALL'
         AND revision.effect_key = 'catch-modifier'
       ORDER BY revision.display_name, balance.item_id`,
      [playerId, contentReleaseId],
    );
    return result.rows.map((row) => ({
      itemId: row.item_id,
      displayName: row.display_name,
      quantity: BigInt(row.quantity),
    }));
  }
}
