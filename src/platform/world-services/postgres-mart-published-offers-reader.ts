import type { Pool } from "pg";
import type {
  MartPublishedOffer,
  MartPublishedOfferReader,
} from "../../modules/world-services/mart-published-offers.js";

/** Read-only live catalog projection; never creates grants or changes ACTIVE. */
export class PostgresMartPublishedOffersReader implements MartPublishedOfferReader {
  public constructor(private readonly pool: Pool) {}

  public async listPublishedOffers(): Promise<readonly MartPublishedOffer[]> {
    const result = await this.pool.query<{
      offer_key: string;
      item_quantity: string;
      price_amount: string;
    }>(
      `SELECT offer.offer_key,
              offer.item_quantity::text AS item_quantity,
              offer.price_amount::text AS price_amount
         FROM content_release_pointers pointer
         JOIN content_releases release
           ON release.id = pointer.content_release_id
          AND release.status = 'PUBLISHED'
         JOIN item_purchase_offers offer
           ON offer.content_release_id = release.id AND offer.active = TRUE
         JOIN item_revisions item_revision
           ON item_revision.content_release_id = release.id
          AND item_revision.item_id = offer.item_id
          AND item_revision.active = TRUE
        WHERE pointer.pointer_key = 'ACTIVE'
        ORDER BY offer.sort_order, offer.offer_key`,
    );
    return result.rows.map((offer) => ({
      offerKey: offer.offer_key,
      itemQuantity: BigInt(offer.item_quantity),
      priceAmount: BigInt(offer.price_amount),
    }));
  }
}
